import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Each channel's public Atom feed (no auth) lists its latest 15 uploads.
// Regex-extracted like techcrunch-ingest: the <entry> shape is flat and stable.
const CHANNELS = [
  // Channel 5 with Andrew Callaghan
  "UC-AQKm7HUNMmxjdS371MSwg",
];
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

function decodeEntities(s: string): string {
  return s
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

  let fetched = 0;
  let skippedShorts = 0;
  let upserted = 0;
  const errors: unknown[] = [];

  for (const channel of CHANNELS) {
    const res = await fetch(FEED_URL + channel);
    if (!res.ok) {
      errors.push({ channel, status: res.status });
      continue;
    }
    const entries = (await res.text()).match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    fetched += entries.length;

    for (const entry of entries) {
      const videoId = extractTag(entry, "yt:videoId");
      const title = extractTag(entry, "title");
      const published = extractTag(entry, "published");
      if (!videoId || !title) continue;
      // Shorts are vertical clips, not the channel's videos.
      if (/<link rel="alternate" href="[^"]*\/shorts\//.test(entry)) {
        skippedShorts++;
        continue;
      }
      // Dated by upload, not ingest, so a channel's backlog doesn't all rank as new.
      const row = {
        url: WATCH_URL + videoId,
        title,
        origin: "feed",
        submitted_by: null,
        image_url: THUMBNAIL_URL(videoId),
        ...(published ? { created_at: published } : {}),
      };
      const { error } = await supabase.from("links").upsert(row, { onConflict: "url" });
      if (error) errors.push({ videoId, error: error.message });
      else upserted++;
    }
  }

  const { data: authorless, error: sweepError } = await supabase
    .from("links")
    .select("id, url")
    .is("author", null)
    .ilike("url", "%youtu%")
    .order("created_at", { ascending: false })
    .limit(AUTHOR_SWEEP_LIMIT);
  if (sweepError) errors.push({ sweep: sweepError.message });
  let authored = 0;
  for (const { id, url } of (authorless ?? []).filter((row) => VIDEO_ID.test(row.url))) {
    const author = await channelOf(url);
    if (!author) continue;
    const { error } = await supabase.from("links").update({ author }).eq("id", id);
    if (error) errors.push({ id, error: error.message });
    else authored++;
  }

  return new Response(JSON.stringify({ fetched, skippedShorts, upserted, authored, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
