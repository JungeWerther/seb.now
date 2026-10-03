import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Any site's own RSS 2.0 or Atom feed: the enabled web_feed rows in sources,
// whose identifier is the feed URL. Regex-extracted like techcrunch-ingest;
// both formats keep each post in a flat <item>/<entry> block.
const ITEMS_PER_FEED = 10;
const FEED_FETCH_TIMEOUT_MS = 10000;
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const DESCRIPTION_MAX_CHARS = 500;
const DESCRIPTION_MIN_CHARS = 20;
const USER_AGENT = "seb.now feed reader (+https://seb.now)";

// WordPress appends this to every excerpt; it says nothing about the post.
const WORDPRESS_FOOTER = /(?:The post .+ appeared first on .+|L[’']article .+ est apparu en premier sur .+)$/s;

type Item = { title: string; url: string; published: string | null; description: string | null };

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : null;
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, "i"))?.[1];
}

// Atom posts carry their page in <link rel="alternate" href>, or a <link>
// with no rel at all; rel="self"/"edit"/"enclosure" point elsewhere.
function atomLink(block: string): string | null {
  for (const tag of block.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel") ?? "alternate";
    const href = attr(tag, "href");
    if (rel === "alternate" && href) return decodeEntities(href);
  }
  return null;
}

// Titles can carry markup (Atom type="html"); the feed shows plain text.
function plainTitle(title: string): string {
  return decodeEntities(title.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");
}

// A summary is usually escaped HTML: decoded once to get the markup, stripped,
// then decoded again for the entities inside it. Cut at a word boundary.
function plainDescription(raw: string | null): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(WORDPRESS_FOOTER, "")
    .trim();
  if (text.length < DESCRIPTION_MIN_CHARS) return null;
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

function httpUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// A future or unparseable date is left out, so the link keeps ingest time.
function pastDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) || date.getTime() > Date.now() ? null : date.toISOString();
}

function parseFeed(xml: string, feedUrl: string): Item[] {
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi);
  const blocks = atomEntries ?? xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return blocks
    .map((block) => {
      const rawTitle = extractTag(block, "title");
      const url = httpUrl(atomEntries ? atomLink(block) : extractTag(block, "link"), feedUrl);
      const date = atomEntries
        ? extractTag(block, "published") ?? extractTag(block, "updated")
        : extractTag(block, "pubDate") ?? extractTag(block, "dc:date");
      const summary = atomEntries
        ? extractTag(block, "summary") ?? extractTag(block, "content")
        : extractTag(block, "description") ?? extractTag(block, "content:encoded");
      return {
        title: rawTitle ? plainTitle(rawTitle) : "",
        url,
        published: pastDate(date),
        description: plainDescription(summary),
      };
    })
    .filter((item): item is Item => !!item.title && !!item.url)
    .slice(0, ITEMS_PER_FEED);
}

// Posts link to arbitrary sites, so only a declared preview image counts,
// as in hn-ingest.
function metaContent(html: string, key: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"))?.[1]
  );
}

async function scrapePreviewImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await res.text();
    const declared = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    return declared ? httpUrl(decodeEntities(declared), pageUrl) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const errors: unknown[] = [];
  const { data: sources, error: sourcesError } = await supabase
    .from("sources")
    .select("identifier")
    .eq("kind", "web_feed")
    .eq("enabled", true);
  if (sourcesError) errors.push({ sources: sourcesError.message });

  let fetched = 0;
  let upserted = 0;
  let withImage = 0;

  await Promise.all((sources ?? []).map(async ({ identifier: feedUrl }) => {
    let items: Item[];
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push({ feed: feedUrl, status: res.status });
        return;
      }
      items = parseFeed(await res.text(), feedUrl);
    } catch (e) {
      errors.push({ feed: feedUrl, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    fetched += items.length;
    const images = await Promise.all(items.map((item) => scrapePreviewImage(item.url)));
    for (const [i, { title, url, published, description }] of items.entries()) {
      // Omitted rather than null when missing, so a flaky fetch keeps an earlier image
      // and an undated post keeps the time it was first ingested.
      const row = {
        url,
        title,
        origin: "feed",
        submitted_by: null,
        ...(published ? { created_at: published } : {}),
        ...(images[i] ? { image_url: images[i] } : {}),
        ...(description ? { description } : {}),
      };
      const { error } = await supabase.from("links").upsert(row, { onConflict: "url" });
      if (error) errors.push({ url, error: error.message });
      else {
        upserted++;
        if (images[i]) withImage++;
      }
    }
  }));

  return new Response(
    JSON.stringify({ feeds: sources?.length ?? 0, fetched, upserted, withImage, errors }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
