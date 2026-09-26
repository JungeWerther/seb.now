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

  return new Response(JSON.stringify({ fetched, skippedShorts, upserted, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
