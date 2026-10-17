import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  enabledSources,
  httpUrl,
  mapSeries,
  present,
  previewImage,
  type Report,
  serveIngest,
  upsertLink,
} from "../_shared/ingest.ts";
import { CalendarEvent, lastDay, parseCalendar } from "../_shared/ical.ts";
import { ICAL, INGEST } from "../_shared/constants.ts";

// Public event calendars (iCalendar .ics): the enabled ical_feed rows in
// sources, whose identifier is the calendar URL (Luma's
// api.lu.ma/ics/get?entity=calendar|discover&id=…, or any other). Each
// upcoming event becomes a link to its own page, and its dates go straight to
// link_events (labeled_by 'ical'), since the calendar states them: the link is
// marked in link_enrichment.events_at so event-extract doesn't ask Jev again.

// Luma writes the event page and its address into DESCRIPTION; neither is
// part of what the event is about.
const LUMA_PAGE_LINE = /^Get up-to-date information at:\s*(https?:\/\/\S+)\s*/i;
const LUMA_ADDRESS_BLOCK = /^Address:\n(?:.+\n)*?(?:\n|$)/im;
const LUMA_HOSTED_BY = /\n*Hosted by [^\n]*$/i;

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
  return text.length < ICAL.DESCRIPTION_MIN_CHARS ? null : cut(text, ICAL.DESCRIPTION_MAX_CHARS);
}

// The place's name: LOCATION's first comma-separated part. An online event's
// LOCATION is a meeting URL, which isn't a venue.
function venueName(location: string | null): string | null {
  if (!location || httpUrl(location)) return null;
  const name = location.split(",")[0].trim();
  return name ? cut(name, ICAL.VENUE_MAX_CHARS) : null;
}

function evidence(event: CalendarEvent): string {
  const when = [event.start, event.end].filter((t) => t).map((t) => `${t!.date}${t!.time ? ` ${t!.time}` : ""}`).join(" – ");
  return cut([when, event.location].filter((s) => s).join(", "), ICAL.EVIDENCE_MAX_CHARS);
}

function todayIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Not over yet and starting within the horizon, soonest first.
function upcoming(events: CalendarEvent[]): CalendarEvent[] {
  const today = todayIn(ICAL.EVENT_ZONE);
  const horizon = Date.now() + ICAL.HORIZON_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter((e) => !e.cancelled && lastDay(e) >= today && e.start.instant.getTime() <= horizon)
    .sort((a, b) => a.start.instant.getTime() - b.start.instant.getTime())
    .slice(0, ICAL.EVENTS_PER_FEED);
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

// Upcoming events with a page of their own, or none when the calendar can't be
// read (reported).
async function readCalendar(feedUrl: string, report: Report): Promise<{ event: CalendarEvent; url: string }[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": INGEST.USER_AGENT, Accept: "text/calendar, */*" },
      signal: AbortSignal.timeout(ICAL.FEED_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      report({ feed: feedUrl, status: res.status });
      return [];
    }
    return upcoming(parseCalendar(await res.text(), ICAL.EVENT_ZONE))
      .map((event) => ({ event, url: eventPage(event) }))
      .filter((e): e is { event: CalendarEvent; url: string } => !!e.url);
  } catch (e) {
    report({ feed: feedUrl, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// The calendar is the authority on its event's dates: replace whatever an
// earlier run or the page reading found, but never hand labels.
async function recordDates(db: SupabaseClient, linkId: string, event: CalendarEvent, url: string, report: Report) {
  const end = lastDay(event);
  const { error: deleteError } = await db.from("link_events").delete().eq("link_id", linkId).neq("labeled_by", "manual");
  if (deleteError) return report({ url, error: deleteError.message });
  const { error: eventError } = await db.from("link_events").insert({
    link_id: linkId,
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
  if (eventError) report({ url, error: eventError.message });
  const { error: markError } = await db.from("link_enrichment").upsert({ link_id: linkId, events_at: new Date().toISOString() });
  if (markError) report({ url, error: markError.message });
}

Deno.serve(serveIngest(async (db, report) => {
  const sources = await enabledSources(db, "ical_feed", report);
  // The same event can be on several calendars (a community's and the city's),
  // so calendars are read in order and an event is taken from the first.
  const seen = new Set<string>();
  const feeds = await mapSeries(sources, async ({ id: sourceId, identifier: feedUrl }) => {
    const events = (await readCalendar(feedUrl, report)).filter(({ url }) => !seen.has(url));
    events.forEach(({ url }) => seen.add(url));

    const images = await mapLimit(events, ICAL.IMAGE_CONCURRENCY, ({ url }) => previewImage(url));
    const linkIds = await mapSeries(events, async ({ event, url }, i) => {
      const linkId = await upsertLink(db, {
        url,
        title: cut(event.summary, ICAL.TITLE_MAX_CHARS),
        origin: "feed",
        submitted_by: null,
        // Which followed calendar listed it; the database tags the link with it.
        source_id: sourceId,
        ...present({ image_url: images[i], description: plainDescription(event.description) }),
      }, { url }, report);
      if (linkId) await recordDates(db, linkId, event, url, report);
      return linkId;
    });
    return {
      fetched: events.length,
      upserted: linkIds.filter(Boolean).length,
      withImage: linkIds.filter((id, i) => id && images[i]).length,
    };
  });

  const total = (key: keyof (typeof feeds)[number]) => feeds.reduce((sum, feed) => sum + feed[key], 0);
  return { feeds: sources.length, fetched: total("fetched"), upserted: total("upserted"), withImage: total("withImage") };
}));
