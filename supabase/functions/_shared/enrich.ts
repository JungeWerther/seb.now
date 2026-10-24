// The bookkeeping the automatic enrichment steps share: which links a step
// does next (`links_to_enrich`) and recording in `link_enrichment` that a step
// has run on a link, so it isn't retried.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type EnrichStep = "topics" | "entities" | "page_entities" | "relations" | "properties" | "events";

// The next `max` links `step` hasn't run on, read with `columns` (which must
// include `id`), in `links_to_enrich`'s order: newest first.
export async function linksToEnrich<T extends { id: string }>(
  db: SupabaseClient,
  step: EnrichStep,
  max: number,
  columns: string,
): Promise<T[]> {
  const { data: rows, error } = await db.rpc("links_to_enrich", { step, max_results: max });
  if (error) throw new Error(error.message);
  const ids = (rows as { link_id: string }[]).map((r) => r.link_id);
  if (!ids.length) return [];
  const { data, error: linksError } = await db.from("links").select(columns).in("id", ids);
  if (linksError) throw new Error(linksError.message);
  const byId = new Map((data as unknown as T[]).map((link) => [link.id, link]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// Records that `step` ran on these links just now.
export async function markEnriched(
  db: SupabaseClient,
  step: EnrichStep,
  linkIds: readonly string[],
): Promise<{ error: { message: string } | null }> {
  if (!linkIds.length) return { error: null };
  const at = new Date().toISOString();
  const { error } = await db.from("link_enrichment").upsert(linkIds.map((link_id) => ({ link_id, [`${step}_at`]: at })));
  return { error };
}
