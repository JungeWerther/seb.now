import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeEntities, present, previewImage, serveIngest, upsertLink } from "../_shared/ingest.ts";

// Hacker News's public Firebase API - no auth, no rate-limit key needed.
// topstories.json is already ranked; we just take the top N.
const STORIES_LIMIT = 25;
const API = "https://hacker-news.firebaseio.com/v0";

Deno.serve(serveIngest(async (db, report) => {
  const ids: number[] = (await (await fetch(`${API}/topstories.json`)).json()).slice(0, STORIES_LIMIT);

  const outcomes = await Promise.all(ids.map(async (id) => {
    try {
      const item = await (await fetch(`${API}/item/${id}.json`)).json();
      if (!item || item.type !== "story" || !item.title) return null;
      const threadUrl = `https://news.ycombinator.com/item?id=${item.id}`;
      // Stories link to arbitrary sites, so only the page's own declared
      // preview counts, never a guessed <img>.
      const imageUrl = item.url ? await previewImage(item.url) : null;
      const row = {
        url: item.url ?? threadUrl,
        thread_url: threadUrl,
        title: decodeEntities(item.title),
        origin: "feed",
        submitted_by: null,
        ...present({ image_url: imageUrl }),
      };
      const linkId = await upsertLink(db, row, { id }, report);
      return linkId ? { imageUrl } : null;
    } catch (e) {
      report({ id, error: String(e) });
      return null;
    }
  }));

  const upserted = outcomes.filter((o) => o !== null);
  return { fetched: ids.length, upserted: upserted.length, withImage: upserted.filter((o) => o.imageUrl).length };
}));
