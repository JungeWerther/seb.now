import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public Mastodon REST API - no auth needed for public statuses. Not raw
// ActivityPub outbox parsing: Mastodon's JSON API is simpler and stable,
// and every account we pull from happens to be Mastodon.
const ACCOUNTS: { instance: string; handle: string }[] = [
  { instance: "dair-community.social", handle: "DAIR" },
  { instance: "mastodon.art", handle: "colossal" },
];

const POSTS_PER_ACCOUNT = 10;
const IMAGE_FETCH_TIMEOUT_MS = 5000;

// Mastodon wraps long URLs in inline <span> for ellipsis display with no
// real whitespace between spans - only block-level tags (p, br) represent
// an actual word/sentence break, so only those become a space.
function stripHtml(html: string): string {
  const withBreaks = html.replace(/<\/(p|br)\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
  const decoded = withBreaks
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return decoded.replace(/\s+/g, " ").trim();
}

// Mastodon only generates a card for posts with exactly one link, and even
// then not always (e.g. if its fetcher can't reach the target) - so a card
// alone misses plenty of single-link posts. Fall back to the post's own
// markup, where a real link is a plain <a href> with no mention/hashtag
// class (those point back into the fediverse, not out to a source).
function extractLinkedUrl(html: string): string | null {
  const linkTag = /<a\s+href="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = linkTag.exec(html))) {
    if (/class="[^"]*\b(mention|hashtag)\b/.test(match[0])) continue;
    return match[1];
  }
  return null;
}

// When a post links to a single external page, Mastodon's own preview-card
// generator (status.card) already identifies it - more reliable than
// scanning post text for a URL, and gives us the target page's real title.
function titleFrom(status: { content: string; card?: { title?: string } | null }, displayName: string): string {
  if (status.card?.title) return status.card.title;
  const text = stripHtml(status.content);
  if (!text) return `Post by ${displayName}`;
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

// Mastodon's card already carries a preview image when it generated one.
// When it didn't (same cases titleFrom falls back for), peek at the
// target page ourselves: prefer its og:image, else its first <img>.
async function scrapePreviewImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await res.text();
    const ogImage =
      html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)?.[1];
    const candidate = ogImage ?? html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    return candidate ? new URL(candidate, pageUrl).toString() : null;
  } catch {
    return null;
  }
}

async function imageFrom(
  status: { card?: { image?: string | null } | null },
  sourceUrl: string,
): Promise<string | null> {
  if (status.card?.image) return status.card.image;
  return scrapePreviewImage(sourceUrl);
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const results = [];

  for (const { instance, handle } of ACCOUNTS) {
    try {
      const lookupRes = await fetch(
        `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
      );
      if (!lookupRes.ok) {
        results.push({ instance, handle, error: `lookup ${lookupRes.status}` });
        continue;
      }
      const account = await lookupRes.json();

      const statusesRes = await fetch(
        `https://${instance}/api/v1/accounts/${account.id}/statuses?exclude_replies=true&exclude_reblogs=true&limit=${POSTS_PER_ACCOUNT}`,
      );
      if (!statusesRes.ok) {
        results.push({ instance, handle, error: `statuses ${statusesRes.status}` });
        continue;
      }
      const statuses = await statusesRes.json();

      let upserted = 0;
      for (const status of statuses) {
        if (!status.url) continue;
        const sourceUrl = status.card?.url || extractLinkedUrl(status.content) || status.url;
        const imageUrl = await imageFrom(status, sourceUrl);
        const { error } = await supabase.from("links").upsert(
          {
            url: sourceUrl,
            thread_url: status.url,
            title: titleFrom(status, account.display_name || handle),
            image_url: imageUrl,
            origin: "fediverse",
            fediverse_post_uri: status.uri,
            submitted_by: null,
          },
          { onConflict: "fediverse_post_uri" },
        );
        if (error) {
          results.push({ instance, handle, status: status.id, error: error.message });
        } else {
          upserted++;
        }
      }

      results.push({ instance, handle, fetched: statuses.length, upserted });
    } catch (e) {
      results.push({ instance, handle, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
