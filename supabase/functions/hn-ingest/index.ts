import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Hacker News's public Firebase API - no auth, no rate-limit key needed.
// topstories.json is already ranked; we just take the top N.
const STORIES_LIMIT = 25;
const IMAGE_FETCH_TIMEOUT_MS = 5000;

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
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"))?.[1]
  );
}

async function scrapePreviewImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await res.text();
    const declared = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    if (!declared) return null;
    const imageUrl = new URL(decodeEntities(declared), pageUrl);
    return imageUrl.protocol === "https:" || imageUrl.protocol === "http:" ? imageUrl.toString() : null;
  } catch {
    return null;
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
      const imageUrl = item.url ? await scrapePreviewImage(item.url) : null;

      // Omitted rather than null when there's no image, so a flaky fetch keeps an earlier one.
      const row = {
        url,
        thread_url: threadUrl,
        title: decodeEntities(item.title),
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
