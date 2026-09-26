import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// TechCrunch's public RSS feed - no auth. Regex-extracted rather than a
// full XML parser: the feed's <item>/<title>/<link> shape is stable and a
// dependency-free extractor is a smaller surface than a full XML parser in
// this Deno edge runtime for a shape this simple.
const FEED_URL = "https://techcrunch.com/feed/";
const ITEMS_LIMIT = 20;
const IMAGE_FETCH_TIMEOUT_MS = 5000;

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : null;
}

// The feed carries no images, so read each article's og:image cover.
async function scrapeCoverImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const ogImage =
      html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)?.[1];
    return ogImage ? new URL(decodeEntities(ogImage), pageUrl).toString() : null;
  } catch {
    return null;
  }
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const res = await fetch(FEED_URL);
  const xml = await res.text();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  let upserted = 0;
  const errors: unknown[] = [];

  const items = itemBlocks.slice(0, ITEMS_LIMIT)
    .map((block) => ({ title: extractTag(block, "title"), link: extractTag(block, "link") }))
    .filter((item): item is { title: string; link: string } => !!item.title && !!item.link);
  const images = await Promise.all(items.map((item) => scrapeCoverImage(item.link)));

  for (const [i, { title, link }] of items.entries()) {
    // Omitted rather than null when the scrape fails, so a flaky fetch keeps an earlier image.
    const row = { url: link, title, origin: "feed", submitted_by: null, ...(images[i] ? { image_url: images[i] } : {}) };
    const { error } = await supabase.from("links").upsert(row, { onConflict: "url" });
    if (error) errors.push({ link, error: error.message });
    else upserted++;
  }

  return new Response(JSON.stringify({ fetched: itemBlocks.length, upserted, withImage: images.filter(Boolean).length, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
