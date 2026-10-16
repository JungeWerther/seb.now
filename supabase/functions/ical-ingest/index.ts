import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CalendarEvent, lastDay, parseCalendar } from "../_shared/ical.ts";

// Public event calendars (iCalendar .ics): the enabled ical_feed rows in
// sources, whose identifier is the calendar URL (Luma's
// api.lu.ma/ics/get?entity=calendar|discover&id=…, or any other). Each
// upcoming event becomes a link to its own page, and its dates go straight to
// link_events (labeled_by 'ical'), since the calendar states them: the link is
// marked in link_enrichment.events_at so event-extract doesn't ask Jev again.
const EVENT_ZONE = "Europe/Paris"; // link_events dates are wall-clock dates here
const HORIZON_DAYS = 45;
const EVENTS_PER_FEED = 40;
const FEED_FETCH_TIMEOUT_MS = 15000;
const IMAGE_FETCH_TIMEOUT_MS = 5000;
const IMAGE_CONCURRENCY = 6;
const DESCRIPTION_MAX_CHARS = 500;
const DESCRIPTION_MIN_CHARS = 20;
const EVIDENCE_MAX_CHARS = 500;
const VENUE_MAX_CHARS = 300;
const TITLE_MAX_CHARS = 300;
const USER_AGENT = "seb.now feed reader (+https://seb.now)";

// Luma writes the event page and its address into DESCRIPTION; neither is
// part of what the event is about.
const LUMA_PAGE_LINE = /^Get up-to-date information at:\s*(https?:\/\/\S+)\s*/i;
const LUMA_ADDRESS_BLOCK = /^Address:\n(?:.+\n)*?(?:\n|$)/im;
const LUMA_HOSTED_BY = /\n*Hosted by [^\n]*$/i;

function httpUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function eventPage(event: CalendarEvent): string | null {
  return event.url ?? httpUrl(event.description?.match(LUMA_PAGE_LINE)?.[1]);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${space > 0 ? head.slice(0, space) : head}…`;
}

function plainDescription(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(LUMA_PAGE_LINE, "")
    .replace(LUMA_ADDRESS_BLOCK, "")
    .replace(LUMA_HOSTED_BY, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length < DESCRIPTION_MIN_CHARS ? null : cut(text, DESCRIPTION_MAX_CHARS);
}

// The place's name: LOCATION's first comma-separated part. An online event's
// LOCATION is a meeting URL, which isn't a venue.
function venueName(location: string | null): string | null {
  if (!location || httpUrl(location)) return null;
  const name = location.split(",")[0].trim();
  return name ? cut(name, VENUE_MAX_CHARS) : null;
}

function evidence(event: CalendarEvent): string {
  const when = [event.start, event.end].filter((t) => t).map((t) => `${t!.date}${t!.time ? ` ${t!.time}` : ""}`).join(" – ");
  return cut([when, event.location].filter((s) => s).join(", "), EVIDENCE_MAX_CHARS);
}

function todayIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Not over yet and starting within the horizon, soonest first.
function upcoming(events: CalendarEvent[]): CalendarEvent[] {
  const today = todayIn(EVENT_ZONE);
  const horizon = Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter((e) => !e.cancelled && lastDay(e) >= today && e.start.instant.getTime() <= horizon)
    .sort((a, b) => a.start.instant.getTime() - b.start.instant.getTime())
    .slice(0, EVENTS_PER_FEED);
}

function metaContent(html: string, key: string): string | undefined {
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i"))?.[1]
  );
}

async function scrapePreviewImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await res.text();
    const declared = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    return declared ? httpUrl(declared.replace(/&amp;/g, "&"), pageUrl) : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

Deno.serve(async (_req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const errors: unknown[] = [];
  const { data: sources, error: sourcesError } = await db
    .from("sources")
    .select("identifier")
    .eq("kind", "ical_feed")
    .eq("enabled", true);
  if (sourcesError) errors.push({ sources: sourcesError.message });

  // The same event can be on several calendars (a community's and the city's).
  const seen = new Set<string>();
  let fetched = 0;
  let upserted = 0;
  let withImage = 0;

  for (const { identifier: feedUrl } of sources ?? []) {
    let events: { event: CalendarEvent; url: string }[];
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/calendar, */*" },
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push({ feed: feedUrl, status: res.status });
        continue;
      }
      events = upcoming(parseCalendar(await res.text(), EVENT_ZONE))
        .map((event) => ({ event, url: eventPage(event) }))
        .filter((e): e is { event: CalendarEvent; url: string } => !!e.url && !seen.has(e.url));
    } catch (e) {
      errors.push({ feed: feedUrl, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const { url } of events) seen.add(url);
    fetched += events.length;

    const images = await mapLimit(events, IMAGE_CONCURRENCY, ({ url }) => scrapePreviewImage(url));
    for (const [i, { event, url }] of events.entries()) {
      const description = plainDescription(event.description);
      // Omitted rather than null when missing, so a flaky fetch keeps an earlier image.
      const row = {
        url,
        title: cut(event.summary, TITLE_MAX_CHARS),
        origin: "feed",
        submitted_by: null,
        ...(images[i] ? { image_url: images[i] } : {}),
        ...(description ? { description } : {}),
      };
      const { data: link, error } = await db.from("links").upsert(row, { onConflict: "url" }).select("id").single();
      if (error || !link) {
        errors.push({ url, error: error?.message ?? "no row" });
        continue;
      }
      upserted++;
      if (images[i]) withImage++;

      // The calendar is the authority on its event's dates: replace whatever
      // an earlier run or the page reading found, but never hand labels.
      const end = lastDay(event);
      const { error: deleteError } = await db.from("link_events").delete().eq("link_id", link.id).neq("labeled_by", "manual");
      if (deleteError) {
        errors.push({ url, error: deleteError.message });
        continue;
      }
      const { error: eventError } = await db.from("link_events").insert({
        link_id: link.id,
        name: null,
        kind: "other",
        starts_on: event.start.date,
        ends_on: end === event.start.date ? null : end,
        start_time: event.start.time,
        venue_name: venueName(event.location),
        evidence: evidence(event),
        p: 1,
        labeled_by: "ical",
      });
      if (eventError) errors.push({ url, error: eventError.message });
      const { error: markError } = await db.from("link_enrichment").upsert({ link_id: link.id, events_at: new Date().toISOString() });
      if (markError) errors.push({ url, error: markError.message });
    }
  }

  return new Response(
    JSON.stringify({ feeds: sources?.length ?? 0, fetched, upserted, withImage, errors }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
