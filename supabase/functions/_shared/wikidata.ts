// A small reader for Wikidata's public API, enough to say what a place is and
// where it is: search by name, read items' labels, descriptions and the
// claims that place them (P131 located in, P17 country, P297 ISO code, P625
// coordinates). Items are memoized, so a run that meets "Paris" twenty times
// fetches it once.

import { memoize } from "./memo.ts";
import { WIKIDATA } from "./constants.ts";

export interface WikidataItem {
  id: string;
  label: string | null;
  description: string | null;
  // The administrative area it is in, else its country; null for a country.
  parent: string | null;
  country: string | null;
  // ISO 3166-1 alpha-2, set on countries only.
  iso: string | null;
  // Whether it has a location at all (coordinates, an area or a country).
  located: boolean;
}

type Json = Record<string, unknown>;
type Fetch = (url: string) => Promise<Json>;

interface Claim {
  rank?: string;
  mainsnak?: { datavalue?: { value?: unknown } };
  qualifiers?: Record<string, unknown>;
}

// Of a property's claims, the current one with the best rank: preferred over
// normal, never deprecated, and not one that has ended (an end time, P582).
export function bestClaim(entity: Json, property: string): unknown {
  const claims = ((entity.claims as Record<string, Claim[]> | undefined)?.[property] ?? [])
    .filter((c) => c.rank !== "deprecated" && !c.qualifiers?.[WIKIDATA.END_TIME]);
  const best = claims.find((c) => c.rank === "preferred") ?? claims[0];
  return best?.mainsnak?.datavalue?.value ?? null;
}

const itemId = (value: unknown): string | null =>
  typeof value === "object" && value !== null && typeof (value as Json).id === "string" ? (value as Json).id as string : null;

function inLanguages(field: unknown, languages: readonly string[]): string | null {
  const values = (field ?? {}) as Record<string, { value: string }>;
  for (const lang of languages) if (values[lang]?.value) return values[lang].value;
  return null;
}

export function readItem(entity: Json, languages: readonly string[]): WikidataItem {
  const iso = bestClaim(entity, WIKIDATA.ISO_CODE);
  const country = itemId(bestClaim(entity, WIKIDATA.COUNTRY));
  const area = itemId(bestClaim(entity, WIKIDATA.LOCATED_IN));
  const isCountry = typeof iso === "string";
  return {
    id: entity.id as string,
    label: inLanguages(entity.labels, languages),
    description: inLanguages(entity.descriptions, languages),
    parent: isCountry ? null : area ?? (country !== entity.id ? country : null),
    country: isCountry ? entity.id as string : country,
    iso: isCountry ? iso as string : null,
    located: isCountry || area !== null || country !== null || bestClaim(entity, WIKIDATA.COORDINATES) !== null,
  };
}

export function wikidata(fetchJson: Fetch, languages: readonly string[] = WIKIDATA.LANGUAGES) {
  const api = (params: Record<string, string>) =>
    fetchJson(`${WIKIDATA.API}?${new URLSearchParams({ format: "json", ...params })}`);

  // Fetches the items not yet known in one request, and remembers them.
  const fetchItems = async (ids: string[]): Promise<Map<string, WikidataItem>> => {
    const data = ids.length
      ? await api({ action: "wbgetentities", ids: ids.join("|"), props: "labels|descriptions|claims", languages: languages.join("|") })
      : {};
    const found = Object.values((data.entities ?? {}) as Record<string, Json>)
      .filter((e) => !("missing" in e))
      .map((e) => readItem(e, languages));
    found.forEach((it) => item.prime([it.id], it));
    return new Map(found.map((it) => [it.id, it]));
  };

  const item = memoize((id: string) => id, async (id: string) => (await fetchItems([id])).get(id) ?? null, {
    maxEntries: WIKIDATA.CACHED_ITEMS,
  });

  // Items whose label or alias matches `name` in any of the languages, located ones only.
  const search = async (name: string): Promise<WikidataItem[]> => {
    const hits = await Promise.all(languages.map((language) =>
      api({ action: "wbsearchentities", search: name, language, uselang: language, type: "item", limit: String(WIKIDATA.SEARCH_LIMIT) })
    ));
    const ids = [...new Set(hits.flatMap((h) => ((h.search ?? []) as { id: string }[]).map((s) => s.id)))];
    const items = await fetchItems(ids);
    return ids.flatMap((id) => items.get(id) ?? []).filter((it) => it.located);
  };

  // An item and the labels of the area and country it names, in one read.
  const describe = async (it: WikidataItem): Promise<string> => {
    const [area, country] = await Promise.all([it.parent, it.country !== it.id ? it.country : null].map((id) => id ? item(id) : null));
    const where = [area?.label, country && country.id !== area?.id ? country.label : null].filter(Boolean).join(", ");
    return [it.label ?? it.id, it.description ? `: ${it.description}` : "", where ? ` (in ${where})` : ""].join("");
  };

  // The ISO code of the country an item is in (or is).
  const isoOf = async (it: WikidataItem): Promise<string | null> =>
    it.iso ?? (it.country && it.country !== it.id ? (await item(it.country))?.iso ?? null : null);

  return { item, search, describe, isoOf };
}

export type Wikidata = ReturnType<typeof wikidata>;
