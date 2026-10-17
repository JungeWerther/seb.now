// What every ingest function shares: the service_role client, the enabled
// `sources` rows of a kind, the feed-text helpers, the preview-image scrape,
// and the run itself (`serveIngest`), which collects errors and answers with
// the function's summary as JSON.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ENV, INGEST } from "./constants.ts";
import { json, type Report, type Row } from "./helpers.ts";


export type { Report, Row };

// Runs `ingest` with a service_role client and an error sink, and answers
// with its summary plus every error reported along the way.
export function serveIngest(
  ingest: (db: SupabaseClient, report: Report) => Promise<Row>,
): (req: Request) => Promise<Response> {
  return async () => {
    const db = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
    const errors: Row[] = [];
    const summary = await ingest(db, (error) => errors.push(error));
    return json({ ...summary, errors });
  };
}

// `fn` over `items` one at a time, in order.
export function mapSeries<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  return items.reduce<Promise<R[]>>(
    async (done, item, index) => [...await done, await fn(item, index)],
    Promise.resolve([]),
  );
}

// The enabled rows of `kind` in public.sources; a failed read is reported and
// reads as none.
export async function enabledSources(
  db: SupabaseClient,
  kind: string,
  report: Report,
): Promise<{ id: string; identifier: string }[]> {
  const { data, error } = await db.from("sources").select("id, identifier").eq("kind", kind).eq("enabled", true);
  if (error) report({ sources: error.message });
  return data ?? [];
}

// `row` without its null, undefined and empty-string fields. Upserting a row that leaves a
// column out keeps what's stored there, so a flaky image fetch keeps an
// earlier cover and an undated item keeps the time it was first ingested.
export function present(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

// Upserts one links row, reporting a failure under `label`. The stored row's
// id, or null when it failed.
export async function upsertLink(
  db: SupabaseClient,
  row: Row,
  label: Row,
  report: Report,
  onConflict = "url",
): Promise<string | null> {
  const { data, error } = await db.from("links").upsert(row, { onConflict }).select("id").single();
  if (error || !data) {
    report({ ...label, error: error?.message ?? "no row" });
    return null;
  }
  return data.id;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

// The decoded text of the first <tag> in `block`, attributes allowed.
export function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : null;
}

export function httpUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// A future or unparseable date is left out, so the link keeps ingest time.
export function pastDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) || date.getTime() > Date.now() ? null : date.toISOString();
}

function metaContent(html: string, key: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"))?.[1]
  );
}

export interface PreviewOptions {
  // The meta tags that may name the cover, most trusted first.
  keys?: string[];
  // Whether the page's first <img> will do when no meta tag names one.
  firstImage?: boolean;
}

// The cover an HTML page declares for itself, or null.
export async function previewImage(
  pageUrl: string,
  { keys = ["og:image", "twitter:image"], firstImage = false }: PreviewOptions = {},
): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": INGEST.USER_AGENT },
      signal: AbortSignal.timeout(INGEST.IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await res.text();
    const declared = keys.map((key) => metaContent(html, key)).find((value) => value) ??
      (firstImage ? html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] : undefined);
    return declared ? httpUrl(decodeEntities(declared), pageUrl) : null;
  } catch {
    return null;
  }
}
