import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// TechCrunch's public RSS feed - no auth. Regex-extracted rather than a
// full XML parser: the feed's <item>/<title>/<link> shape is stable and a
// dependency-free extractor is a smaller surface than a full XML parser in
// this Deno edge runtime for a shape this simple.
const FEED_URL = "https://techcrunch.com/feed/";
const ITEMS_LIMIT = 20;

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

  for (const block of itemBlocks.slice(0, ITEMS_LIMIT)) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (!title || !link) continue;

    const { error } = await supabase
      .from("links")
      .upsert({ url: link, title, origin: "feed", submitted_by: null }, { onConflict: "url" });
    if (error) errors.push({ link, error: error.message });
    else upserted++;
  }

  return new Response(JSON.stringify({ fetched: itemBlocks.length, upserted, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
