import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Hacker News's public Firebase API - no auth, no rate-limit key needed.
// topstories.json is already ranked; we just take the top N.
const STORIES_LIMIT = 25;

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const topIdsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const topIds: number[] = await topIdsRes.json();
  const ids = topIds.slice(0, STORIES_LIMIT);

  let upserted = 0;
  const errors: unknown[] = [];

  for (const id of ids) {
    try {
      const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item = await itemRes.json();
      if (!item || item.type !== "story" || !item.title) continue;
      const url = item.url ?? `https://news.ycombinator.com/item?id=${item.id}`;

      const { error } = await supabase
        .from("links")
        .upsert({ url, title: item.title, origin: "feed", submitted_by: null }, { onConflict: "url" });
      if (error) errors.push({ id, error: error.message });
      else upserted++;
    } catch (e) {
      errors.push({ id, error: String(e) });
    }
  }

  return new Response(JSON.stringify({ fetched: ids.length, upserted, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
