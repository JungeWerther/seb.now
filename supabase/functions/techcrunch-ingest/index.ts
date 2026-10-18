import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractTag, mapSeries, pastDate, present, previewImage, serveIngest, upsertLink } from "../_shared/ingest.ts";
import { TECHCRUNCH } from "../_shared/constants.ts";

// TechCrunch's public RSS feed - no auth. Regex-extracted rather than a
// full XML parser: the feed's <item>/<title>/<link> shape is stable and a
// dependency-free extractor is a smaller surface than a full XML parser in
// this Deno edge runtime for a shape this simple.

type Item = { title: string; link: string; published: string | null };

Deno.serve(serveIngest(async (db, report) => {
  const itemBlocks = (await (await fetch(TECHCRUNCH.FEED_URL)).text()).match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const items = itemBlocks.slice(0, TECHCRUNCH.ITEMS_LIMIT)
    .map((block) => ({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      published: pastDate(extractTag(block, "pubDate")),
    }))
    .filter((item): item is Item => !!item.title && !!item.link);
  // The feed carries no images, so read each article's og:image cover.
  const images = await Promise.all(items.map((item) => previewImage(item.link, { keys: ["og:image"] })));

  const linkIds = await mapSeries(items, ({ title, link, published }, i) =>
    upsertLink(db, {
      url: link,
      title,
      origin: "feed",
      submitted_by: null,
      ...present({ created_at: published, image_url: images[i] }),
    }, { link }, report)
  );

  return { fetched: itemBlocks.length, upserted: linkIds.filter(Boolean).length, withImage: images.filter(Boolean).length };
}));
