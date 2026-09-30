import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Hacker News's public Firebase API - no auth, no rate-limit key needed.
// topstories.json is already ranked; we just take the top N.
const STORIES_LIMIT = 25;
const PAGE_FETCH_TIMEOUT_MS = 5000;

// HN's API returns titles HTML-escaped (e.g. "Foo &amp; Bar", "&#x27;").
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Stories link to arbitrary sites, so only the page's own declared preview
// image counts (og:image, else twitter:image) - never a guessed <img>, which
// on a random page is as likely a logo or tracking pixel as a cover.
function metaContent(html: string, key: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=(["'])(.+?)\\1`, "i"))?.[2] ??
    html.match(new RegExp(`<meta[^>]+content=(["'])(.+?)\\1[^>]+(?:property|name)=["']${key}["']`, "i"))?.[2]
  );
}

// HN submitters often retitle a Substack post with its subtitle; Substack
// pages (custom domains included) load assets from substackcdn.com, so they
// can be told apart and their author's own og:title used instead.
function isSubstackPage(pageUrl: string, html: string): boolean {
  return new URL(pageUrl).hostname.endsWith(".substack.com") || html.includes("substackcdn.com");
}

type PagePreview = { imageUrl: string | null; title: string | null };

async function scrapePage(pageUrl: string): Promise<PagePreview> {
  const none = { imageUrl: null, title: null };
  try {
    const res = await fetch(pageUrl, { signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return none;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return none;
    const html = await res.text();
    const ogTitle = isSubstackPage(pageUrl, html) ? metaContent(html, "og:title") : undefined;
    const title = ogTitle ? decodeEntities(ogTitle).trim() || null : null;
    const declared = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    if (!declared) return { imageUrl: null, title };
    const imageUrl = new URL(decodeEntities(declared), pageUrl);
    return {
      imageUrl: imageUrl.protocol === "https:" || imageUrl.protocol === "http:" ? imageUrl.toString() : null,
      title,
    };
  } catch {
    return none;
  }
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const topIdsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const topIds: number[] = await topIdsRes.json();
  const ids = topIds.slice(0, STORIES_LIMIT);

  let upserted = 0;
  let withImage = 0;
  const errors: unknown[] = [];

  await Promise.all(ids.map(async (id) => {
    try {
      const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item = await itemRes.json();
      if (!item || item.type !== "story" || !item.title) return;
      const threadUrl = `https://news.ycombinator.com/item?id=${item.id}`;
      const url = item.url ?? threadUrl;
      const { imageUrl, title } = item.url ? await scrapePage(item.url) : { imageUrl: null, title: null };

      // Omitted rather than null when there's no image, so a flaky fetch keeps an earlier one.
      const row = {
        url,
        thread_url: threadUrl,
        title: title ?? decodeEntities(item.title),
        origin: "feed",
        submitted_by: null,
        ...(imageUrl ? { image_url: imageUrl } : {}),
      };
      const { error } = await supabase.from("links").upsert(row, { onConflict: "url" });
      if (error) errors.push({ id, error: error.message });
      else {
        upserted++;
        if (imageUrl) withImage++;
      }
    } catch (e) {
      errors.push({ id, error: String(e) });
    }
  }));

  return new Response(JSON.stringify({ fetched: ids.length, upserted, withImage, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
