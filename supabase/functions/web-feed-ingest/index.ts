import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  decodeEntities,
  enabledSources,
  extractTag,
  httpUrl,
  mapSeries,
  pastDate,
  present,
  previewImage,
  type Report,
  serveIngest,
  upsertLink,
} from "../_shared/ingest.ts";
import { INGEST, WEB_FEED } from "../_shared/constants.ts";

// Any site's own RSS 2.0 or Atom feed: the enabled web_feed rows in sources,
// whose identifier is the feed URL. Regex-extracted rather than parsed: both
// formats keep each post in a flat <item>/<entry> block.

// WordPress appends this to every excerpt; it says nothing about the post.
const WORDPRESS_FOOTER = /(?:The post .+ appeared first on .+|L[’']article .+ est apparu en premier sur .+)$/s;

type Item = { title: string; url: string; published: string | null; description: string | null };

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, "i"))?.[1];
}

// Atom posts carry their page in <link rel="alternate" href>, or a <link>
// with no rel at all; rel="self"/"edit"/"enclosure" point elsewhere.
function atomLink(block: string): string | null {
  const href = (block.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => (attr(tag, "rel") ?? "alternate") === "alternate")
    .map((tag) => attr(tag, "href"))
    .find((href) => href);
  return href ? decodeEntities(href) : null;
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
  if (text.length < WEB_FEED.DESCRIPTION_MIN_CHARS) return null;
  if (text.length <= WEB_FEED.DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, WEB_FEED.DESCRIPTION_MAX_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)}…`;
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
    .slice(0, WEB_FEED.ITEMS_PER_FEED);
}

// The feed's items, or none when it can't be read (reported).
async function readFeed(feedUrl: string, report: Report): Promise<Item[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": INGEST.USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(WEB_FEED.FEED_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      report({ feed: feedUrl, status: res.status });
      return [];
    }
    return parseFeed(await res.text(), feedUrl);
  } catch (e) {
    report({ feed: feedUrl, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// Feeds are fetched side by side; each feed's posts are upserted in order.
Deno.serve(serveIngest(async (db, report) => {
  const sources = await enabledSources(db, "web_feed", report);
  const feeds = await Promise.all(sources.map(async ({ id: sourceId, identifier: feedUrl }) => {
    const items = await readFeed(feedUrl, report);
    // Posts link to arbitrary sites, so only a declared preview image counts.
    const images = await Promise.all(items.map((item) => previewImage(item.url)));
    const linkIds = await mapSeries(items, ({ title, url, published, description }, i) =>
      upsertLink(db, {
        url,
        title,
        origin: "feed",
        submitted_by: null,
        // Which followed feed it came from; the database tags the link with it.
        source_id: sourceId,
        ...present({ created_at: published, image_url: images[i], description }),
      }, { url }, report)
    );
    return {
      fetched: items.length,
      upserted: linkIds.filter(Boolean).length,
      withImage: linkIds.filter((id, i) => id && images[i]).length,
    };
  }));

  const total = (key: keyof (typeof feeds)[number]) => feeds.reduce((sum, feed) => sum + feed[key], 0);
  return { feeds: sources.length, fetched: total("fetched"), upserted: total("upserted"), withImage: total("withImage") };
}));
