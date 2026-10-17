import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { enabledSources, extractTag, mapSeries, present, serveIngest, upsertLink } from "../_shared/ingest.ts";
import { YOUTUBE } from "../_shared/constants.ts";

// Each followed channel's public Atom feed (no auth) lists its latest 15
// uploads. Regex-extracted like web-feed-ingest: the <entry> shape is flat
// and stable. The channels are the enabled youtube_channel rows in sources.

const VIDEO_ID = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// The channel's "@handle" from its URL, else its display name.
async function channelOf(videoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(YOUTUBE.OEMBED_URL + encodeURIComponent(videoUrl), {
      signal: AbortSignal.timeout(YOUTUBE.OEMBED_TIMEOUT_MS),
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
    const res = await fetch(YOUTUBE.FEED_URL + channel);
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
        url: YOUTUBE.WATCH_URL + videoId,
        title,
        origin: "feed",
        submitted_by: null,
        // Which followed channel posted it; the database tags the link with it.
        source_id: sourceId,
        image_url: YOUTUBE.THUMBNAIL_URL(videoId),
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
    .limit(YOUTUBE.AUTHOR_SWEEP_LIMIT);
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
