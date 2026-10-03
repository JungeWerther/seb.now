import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { fetchPage, JsonLdEvent, pageText, Section } from "./content.ts";
import { DateCandidate, dateCandidates, Source } from "./dates.ts";

// Finds the events a link announces and when they happen, from its own page.
// Per link:
//  1. the page is fetched and cleaned into text sections (content.ts) and kept
//     in `link_content`;
//  2. if it declares schema.org Events, those are taken as they are;
//  3. otherwise code finds every date in the title, feed description and page
//     (dates.ts). If none is later than the day before the link was published,
//     the link announces nothing and no Jev call is made;
//  4. one Jev request asks whether the page announces one event, lists several
//     or neither; what each date is (the event's run, its start, its end, a
//     day it happens on, or something else); what kind of event it is (per
//     section, for a listing, whose headings name the events); and which of
//     the link's place entities is the venue. Dates in the title or feed
//     description say what the link is about, so for a page about one event
//     they win over dates found further down (often other events').
// Events over before the link was published are dropped. Rows land in
// `link_events`; every processed link gets `link_enrichment.events_at`,
// whether it announced anything or not.
//
// POST {} processes up to LINKS_PER_RUN unprocessed links, newest first;
// POST {"link_ids": [...]} those links. "dry_run": true reports without writing.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const LINKS_PER_RUN = 10;
const MAX_LINK_IDS = 50;
const CONCURRENCY = 4;
const MIN_PAGE_P = 0.5;
const MAX_NOT_AN_EVENT_P = 0.5;
const MIN_ROLE_P = 0.5;
const MIN_VENUE_P = 0.5;
const LEAD_CHARS = 600;
const EXCERPT_CHARS = 300;
const DESCRIPTION_CHARS = 500;
const RECENT_MS = 24 * 60 * 60 * 1000;
const NONE = "none";
const NOT_AN_EVENT = "not_an_event";

const PAGE_OPTIONS = {
  single_event:
    "It announces or reviews one particular event people can attend or visit on given dates: an exhibition, " +
    "show, concert, screening, talk, festival, market, match, party or tour (a festival with a programme is one event).",
  event_listing:
    "It is a guide or agenda listing several separate events, each under its own heading or entry.",
  other:
    "Neither: news, an essay, a review of a book or record, a product, a place or a recipe; dates in it are " +
    "news dates, not when something can be attended.",
};

const RANGE_ROLES = {
  period: "The period the event runs or is open (from the first date to the last).",
  other: "Something else: when something else runs, a past edition, a booking window or not about the event.",
};

const DAY_ROLES = {
  start: "The day the event starts or opens; it runs on after that.",
  end: "The day the event ends or closes (\"until\", \"jusqu'au\"); it started before.",
  on: "A day the event takes place: a one-day event, or one dated session or night of it.",
  other:
    "Something else: when the page was published or updated, a booking deadline, a past edition, another " +
    "event, or not about the event at all.",
};

const KIND_OPTIONS = {
  exhibition: "An exhibition, show of art or objects, installation or museum display.",
  concert: "A concert, gig, recital or DJ set.",
  performance: "Theatre, opera, dance, circus, comedy or another staged show.",
  screening: "A film screening or film season.",
  talk: "A talk, reading, debate, conference, class or workshop.",
  festival: "A festival with a programme of several events.",
  market_fair: "A market, fair, salon, trade show or sale.",
  sport: "A match, race or other sports event.",
  family: "An activity for children or families.",
  party: "A party, club night or celebration.",
  tour: "A guided visit, tour, open day or open house.",
  other: "Another kind of event.",
  [NOT_AN_EVENT]: "Not an event people can attend.",
};

type Kind = Exclude<keyof typeof KIND_OPTIONS, typeof NOT_AN_EVENT>;
type Role = keyof typeof DAY_ROLES | keyof typeof RANGE_ROLES;

// schema.org Event subtypes, most specific first; anything else is "other".
const JSON_LD_KINDS: [RegExp, Kind][] = [
  [/Exhibition/, "exhibition"],
  [/Music/, "concert"],
  [/Theater|Dance|Comedy/, "performance"],
  [/Screening/, "screening"],
  [/Education|Literary|Business/, "talk"],
  [/Festival/, "festival"],
  [/Sale/, "market_fair"],
  [/Sports/, "sport"],
  [/Childrens/, "family"],
  [/Social/, "party"],
  [/Visual/, "exhibition"],
];

interface Link {
  id: string;
  title: string;
  url: string;
  description: string | null;
  created_at: string;
}

interface Place {
  id: string;
  name: string;
}

interface EventRow {
  name: string | null;
  kind: Kind;
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  venue_entity_id: string | null;
  venue_name: string | null;
  evidence: string | null;
  p: number;
  labeled_by: "jev" | "json_ld";
}

interface Judged extends DateCandidate {
  role: Role;
  roleP: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const round = (p: number) => Math.round(p * 1000) / 1000;
const yearEarlier = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const time = (iso: string | null) => iso?.match(/T(\d{2}:\d{2})/)?.[1] ?? null;

function jsonLdRows(events: JsonLdEvent[]): EventRow[] {
  return events.flatMap((e) => {
    const starts = day(e.startDate);
    const ends = day(e.endDate);
    if (!starts && !ends) return [];
    return [{
      name: e.name,
      kind: JSON_LD_KINDS.find(([re]) => re.test(e.type))?.[1] ?? "other",
      starts_on: starts,
      ends_on: ends && (!starts || ends > starts) ? ends : null,
      start_time: time(e.startDate),
      venue_entity_id: null,
      venue_name: e.location,
      evidence: null,
      p: 1,
      labeled_by: "json_ld" as const,
    }];
  });
}

// The dates of one event (the page, or one section of a listing) become rows:
// its run (a range, else a start and/or an end) if it has one, else one row
// per day it happens on.
function unitRows(dates: Judged[], name: string | null, kind: Kind, baseP: number, venue: string | null): EventRow[] {
  const best = (role: Role) =>
    dates.filter((d) => d.role === role).sort((a, b) => b.roleP - a.roleP)[0];
  const row = (starts: string | null, ends: string | null, startTime: string | null, evidence: Judged, p: number): EventRow => ({
    name, kind, starts_on: starts, ends_on: ends, start_time: startTime,
    venue_entity_id: venue, venue_name: null, evidence: evidence.context.slice(0, 500),
    p: round(Math.min(baseP, p)), labeled_by: "jev",
  });

  const period = best("period");
  if (period) return [row(period.start, period.end, period.time, period, period.roleP)];
  const start = best("start");
  const end = best("end");
  if (start || end) {
    // A start resolved after its own end ("depuis le 28 mars … jusqu'au 1er
    // novembre", read in October) is the year before.
    let starts: string | null = start?.start ?? null;
    if (starts && end && starts > end.start) starts = yearEarlier(starts) <= end.start ? yearEarlier(starts) : null;
    const ends = end && (!starts || end.start > starts) ? end.start : null;
    return [row(starts, ends, start?.time ?? null, (start ?? end)!, Math.min(start?.roleP ?? 1, end?.roleP ?? 1))];
  }
  return dates.filter((d) => d.role === "on").map((d) => row(d.start, null, d.time, d, d.roleP));
}

async function loadPlaces(db: SupabaseClient, linkId: string): Promise<Place[]> {
  const { data, error } = await db
    .from("link_entities")
    .select("entities!inner(id, name, kind)")
    .eq("link_id", linkId)
    .eq("entities.kind", "place");
  if (error) throw new Error(error.message);
  return (data as unknown as { entities: Place }[]).map((r) => r.entities);
}

async function processLink(db: SupabaseClient, jev: JevClient, link: Link, dryRun: boolean) {
  const page = await fetchPage(link.url);
  const reference = new Date(link.created_at);
  const report = { link_id: link.id, title: link.title, status: page.status, page: null as string | null, dates: [] as unknown[], events: [] as EventRow[], inputTokens: 0 };

  let rows: EventRow[] = jsonLdRows(page.jsonLdEvents);
  if (!rows.length) {
    const sources: Source[] = [
      { text: link.title, origin: "title", section: null },
      ...(link.description ? [{ text: link.description, origin: "description" as const, section: null }] : []),
      ...page.sections.map((s, i) => ({ text: [s.heading, s.text].filter(Boolean).join("\n"), origin: "page" as const, section: i })),
    ];
    const candidates = dateCandidates(sources, reference, page.lang);
    const cutoff = new Date(reference.getTime() - RECENT_MS).toISOString().slice(0, 10);
    if (candidates.some((c) => (c.end ?? c.start) >= cutoff)) {
      rows = (await judge(db, jev, link, page.sections, candidates, report))
        .filter((r) => (r.ends_on ?? r.starts_on)! >= cutoff);
    } else {
      report.dates = candidates.map((c) => ({ text: c.text, start: c.start, end: c.end, role: "past" }));
    }
  }
  report.events = rows;

  if (!dryRun) {
    const { error: contentError } = await db.from("link_content").upsert({
      link_id: link.id,
      fetched_at: new Date().toISOString(),
      status: page.status,
      lang: page.lang?.slice(0, 35) ?? null,
      text: pageText(page.sections) || null,
      json_ld_events: page.jsonLdEvents.length ? page.jsonLdEvents : null,
    });
    if (contentError) throw new Error(contentError.message);
    const { error: deleteError } = await db.from("link_events").delete().eq("link_id", link.id).in("labeled_by", ["jev", "json_ld"]);
    if (deleteError) throw new Error(deleteError.message);
    if (rows.length) {
      const { error } = await db.from("link_events").upsert(
        rows.map((r) => ({ link_id: link.id, ...r })),
        { onConflict: "link_id,name,starts_on,ends_on", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    }
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, events_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return report;
}

async function judge(
  db: SupabaseClient,
  jev: JevClient,
  link: Link,
  sections: Section[],
  candidates: DateCandidate[],
  report: { page: string | null; dates: unknown[]; inputTokens: number },
): Promise<EventRow[]> {
  const places = await loadPlaces(db, link.id);
  const lead = sections.map((s) => s.text).join("\n").slice(0, LEAD_CHARS);
  const state = {
    link: {
      title: link.title,
      site: hostOf(link.url),
      ...(link.description ? { description: link.description.slice(0, DESCRIPTION_CHARS) } : {}),
      ...(lead ? { lead } : {}),
    },
  };
  // Sections of a listing that have both a heading and dates of their own.
  const headed = [...new Set(candidates.flatMap((c) => (c.section !== null && sections[c.section].heading ? [c.section] : [])))];

  const questions: Record<string, ChoiceQuestion> = {
    page: { type: "choice", instructions: { question: "What is `link`?" }, criteria: PAGE_OPTIONS },
    kind: {
      type: "choice",
      instructions: { question: "If `link` is about one event, what kind of event is it?" },
      criteria: KIND_OPTIONS,
    },
  };
  candidates.forEach((c, i) => {
    questions[`d${i}`] = {
      type: "choice",
      instructions: {
        date: c.text,
        sentence: c.context,
        found_in: c.origin === "page" && c.section !== null && sections[c.section].heading
          ? `the page section headed "${sections[c.section].heading}"`
          : c.origin === "page" ? "the page" : `the link's ${c.origin}`,
        question: "For the event `sentence` is about, what is `date`?",
      },
      criteria: c.end ? RANGE_ROLES : DAY_ROLES,
    };
  });
  headed.forEach((s) => {
    questions[`s${s}`] = {
      type: "choice",
      instructions: {
        heading: sections[s].heading,
        excerpt: sections[s].text.slice(0, EXCERPT_CHARS),
        question: "If `link` lists several events, what kind of event is the one under `heading`?",
      },
      criteria: KIND_OPTIONS,
    };
  });
  if (places.length) {
    questions.venue = {
      type: "choice",
      instructions: { question: "If `link` is about one event, which of these places is it held at?" },
      criteria: { ...Object.fromEntries(places.map((p) => [p.id, p.name])), [NONE]: "None of these, or not said." },
    };
  }

  const result = await jev.ask(state, questions);
  report.inputTokens = result.usage.input_tokens;
  const answer = (key: string) => {
    const a = result.answers[key];
    return { choice: a.choice, p: a.probabilities[a.choice] };
  };
  // The likeliest kind of event, unless "not an event" is likely; its p is
  // how likely it is to be an event at all, since kinds can split the rest.
  const kindOf = (key: string): { kind: Kind; p: number } | null => {
    const probabilities = result.answers[key].probabilities as Record<string, number>;
    const notP = probabilities[NOT_AN_EVENT] ?? 0;
    if (notP >= MAX_NOT_AN_EVENT_P) return null;
    const [kind] = Object.entries(probabilities)
      .filter(([k]) => k !== NOT_AN_EVENT)
      .sort((a, b) => b[1] - a[1])[0];
    return { kind: kind as Kind, p: 1 - notP };
  };

  const page = answer("page");
  report.page = `${page.choice} (${round(page.p)})`;
  const judged: Judged[] = candidates.flatMap((c, i) => {
    const a = answer(`d${i}`);
    report.dates.push({ text: c.text, start: c.start, end: c.end, in: c.origin, section: c.section, role: a.choice, p: round(a.p) });
    return a.choice !== "other" && a.p >= MIN_ROLE_P ? [{ ...c, role: a.choice as Role, roleP: a.p }] : [];
  });
  if (page.choice === "other" || page.p < MIN_PAGE_P) return [];

  if (page.choice === "single_event") {
    const kind = kindOf("kind");
    if (!kind) return [];
    const venue = places.length ? answer("venue") : null;
    const venueId = venue && venue.choice !== NONE && venue.p >= MIN_VENUE_P ? venue.choice : null;
    const fromLink = judged.filter((d) => d.origin !== "page");
    return unitRows(fromLink.length ? fromLink : judged, null, kind.kind, Math.min(page.p, kind.p), venueId);
  }
  return headed.flatMap((s) => {
    const kind = kindOf(`s${s}`);
    if (!kind) return [];
    const name = sections[s].heading!.slice(0, 300);
    return unitRows(judged.filter((d) => d.section === s), name, kind.kind, Math.min(page.p, kind.p), null);
  });
}

async function unprocessedLinkIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.rpc("links_to_enrich", { step: "events", max_results: LINKS_PER_RUN });
  if (error) throw new Error(error.message);
  return (data as { link_id: string }[]).map((r) => r.link_id);
}

Deno.serve(async (req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const given: unknown = body?.link_ids;
  if (given !== undefined && (!Array.isArray(given) || given.length > MAX_LINK_IDS || !given.every((i) => typeof i === "string"))) {
    return new Response(JSON.stringify({ error: `link_ids must be at most ${MAX_LINK_IDS} ids` }), { status: 400 });
  }
  const { data: apiKey, error: keyError } = await db.rpc("get_vault_secret", { secret_name: TYPESAFE_KEY_SECRET });
  if (keyError || !apiKey) {
    return new Response(JSON.stringify({ error: `no ${TYPESAFE_KEY_SECRET} in Vault` }), { status: 500 });
  }
  const jev = new JevClient(apiKey, MODEL);

  const ids = (given as string[] | undefined) ?? await unprocessedLinkIds(db);
  const { data: links, error } = await db.from("links").select("id, title, url, description, created_at").in("id", ids);
  if (error) throw new Error(error.message);

  const results: Awaited<ReturnType<typeof processLink>>[] = [];
  const errors: unknown[] = [];
  const queue = [...(links as Link[])];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      try {
        results.push(await processLink(db, jev, link, dryRun));
      } catch (e) {
        errors.push({ link_id: link.id, error: String(e) });
      }
    }
  }));
  const events = results.flatMap((r) => r.events);
  return new Response(
    JSON.stringify({
      model: MODEL,
      dry_run: dryRun,
      links: results.length,
      jev_calls: results.filter((r) => r.page !== null).length,
      events: events.length,
      input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
      errors,
      results,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
