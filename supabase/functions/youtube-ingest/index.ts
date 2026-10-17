import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { enabledSources, extractTag, mapSeries, present, serveIngest, upsertLink } from "../_shared/ingest.ts";

// Each followed channel's public Atom feed (no auth) lists its latest 15
// uploads. Regex-extracted like techcrunch-ingest: the <entry> shape is flat
// and stable. The channels are the enabled youtube_channel rows in sources.
const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const WATCH_URL = "https://www.youtube.com/watch?v=";
// 4:3 with letterbox bars on 16:9 videos; the page's 16:9 cover crop removes
// them exactly. Unlike maxresdefault, it exists for every video.
const THUMBNAIL_URL = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
// oEmbed answers data-centre requests (unlike the watch page's og tags) and
// names the uploading channel, which becomes links.author.
const OEMBED_URL = "https://www.youtube.com/oembed?format=json&url=";
const OEMBED_TIMEOUT_MS = 5000;
// YouTube links from any ingest (e.g. Hacker News) still without an author,
// looked up per run.
const AUTHOR_SWEEP_LIMIT = 50;
const VIDEO_ID = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// The channel's "@handle" from its URL, else its display name.
async function channelOf(videoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(OEMBED_URL + encodeURIComponent(videoUrl), {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { author_url, author_name } = await res.json();
    const handle = typeof author_url === "string" ? author_url.match(/\/(@[^/?#]+)/)?.[1] : undefined;
    const author = handle ? decodeURIComponent(handle) : typeof author_name === "string" ? author_name.trim() : "";
    return author ? author.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// Shorts are vertical clips, not the channel's videos.
const SHORTS_LINK = /<link rel="alternate" href="[^"]*\/shorts\//;

Deno.serve(serveIngest(async (db, report) => {
  const channels = await mapSeries(await enabledSources(db, "youtube_channel", report), async ({ id: sourceId, identifier: channel }) => {
    const res = await fetch(FEED_URL + channel);
    if (!res.ok) {
      report({ channel, status: res.status });
      return { fetched: 0, skippedShorts: 0, upserted: 0 };
    }
    const entries = (await res.text()).match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    const videos = entries
      .map((entry) => ({
        videoId: extractTag(entry, "yt:videoId"),
        title: extractTag(entry, "title"),
        published: extractTag(entry, "published"),
        short: SHORTS_LINK.test(entry),
      }))
      .filter((video): video is { videoId: string; title: string; published: string | null; short: boolean } =>
        !!video.videoId && !!video.title
      );
    const linkIds = await mapSeries(videos.filter((video) => !video.short), ({ videoId, title, published }) =>
      upsertLink(db, {
        url: WATCH_URL + videoId,
        title,
        origin: "feed",
        submitted_by: null,
        // Which followed channel posted it; the database tags the link with it.
        source_id: sourceId,
        image_url: THUMBNAIL_URL(videoId),
        // Dated by upload, not ingest, so a channel's backlog doesn't all rank as new.
        ...present({ created_at: published }),
      }, { videoId }, report)
    );
    return {
      fetched: entries.length,
      skippedShorts: videos.filter((video) => video.short).length,
      upserted: linkIds.filter(Boolean).length,
    };
  });

  const { data: authorless, error: sweepError } = await db
    .from("links")
    .select("id, url")
    .is("author", null)
    .ilike("url", "%youtu%")
    .order("created_at", { ascending: false })
    .limit(AUTHOR_SWEEP_LIMIT);
  if (sweepError) report({ sweep: sweepError.message });
  const authored = await mapSeries((authorless ?? []).filter((row) => VIDEO_ID.test(row.url)), async ({ id, url }) => {
    const author = await channelOf(url);
    if (!author) return false;
    const { error } = await db.from("links").update({ author }).eq("id", id);
    if (error) report({ id, error: error.message });
    return !error;
  });

  const total = (key: keyof (typeof channels)[number]) => channels.reduce((sum, channel) => sum + channel[key], 0);
  return {
    fetched: total("fetched"),
    skippedShorts: total("skippedShorts"),
    upserted: total("upserted"),
    authored: authored.filter(Boolean).length,
  };
}));
