import * as chrono from "npm:chrono-node@2.10.2";
import { sentenceAround } from "../_shared/page.ts";

// Date mentions found by code, no model: every date or date range chrono can
// read in the link's title, its feed description and each section of its page,
// with the sentence it sits in. Jev only decides what each one is (an event's
// start, end, a single day, or something else), the way entity-extract's
// candidates.ts proposes names for Jev to accept or reject.
//
// A mention must name a day ("18h" alone is dropped). A year left out is the
// one that puts the date (or the range) nearest to `reference`, the link's own
// date: "samedi 7 novembre" in an October article is the coming one, "14
// février" in a July one is the past one, and "du 2 au 12 octobre" on 3 October
// is under way. A range whose end then falls before its start runs over New
// Year. The same date read twice is kept once, at its first place: title
// before description before page.

const MAX_CANDIDATES = 20;

export type Origin = "title" | "description" | "page";

export interface DateCandidate {
  text: string;
  start: string;
  end: string | null;
  time: string | null;
  context: string;
  origin: Origin;
  section: number | null;
}

export interface Source {
  text: string;
  origin: Origin;
  section: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function utcDay(year: number, c: chrono.ParsedComponents): number {
  return Date.UTC(year, c.get("month")! - 1, c.get("day")!);
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// [start, end] as UTC days, the years left out chosen nearest to `reference`.
function resolve(r: chrono.ParsedResult, reference: Date): [number, number | null] {
  const ref = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
  const endC = r.end && r.end.isCertain("day") ? r.end : null;
  const at = (year: number): [number, number | null] => {
    const start = utcDay(year, r.start);
    if (!endC) return [start, null];
    let end = utcDay(endC.isCertain("year") ? endC.get("year")! : year, endC);
    if (end < start && !endC.isCertain("year")) end = utcDay(year + 1, endC);
    return [start, end];
  };
  if (r.start.isCertain("year")) return at(r.start.get("year")!);
  // "du 28 octobre au 1er novembre 2026": the start takes the end's year.
  if (endC?.isCertain("year")) {
    const [start, end] = at(endC.get("year")!);
    return start <= end! ? [start, end] : at(endC.get("year")! - 1);
  }
  const distance = ([start, end]: [number, number | null]) =>
    ref < start ? start - ref : ref > (end ?? start) ? ref - (end ?? start) : 0;
  const year = reference.getUTCFullYear();
  // Ties go forward: a date as far ahead as behind is more likely announced than reported.
  return [at(year), at(year + 1), at(year - 1)].reduce((best, x) => (distance(x) < distance(best) ? x : best));
}

// French pages are read with chrono's French parser first; the English one
// then only adds mentions that don't overlap one already found. Numeric dates
// are read day first ("04.11.2026" is 4 November) unless the page says it's
// American English: a page that couldn't be fetched has no language, and these
// feeds are mostly European.
function parse(text: string, reference: Date, lang: string | null): chrono.ParsedResult[] {
  const english = lang === "en-us" ? chrono.en : chrono.en.GB;
  const parsers = lang?.startsWith("fr") ? [chrono.fr, english] : [english, chrono.fr];
  const found: chrono.ParsedResult[] = [];
  for (const parser of parsers) {
    for (const r of parser.parse(text, reference, { forwardDate: true })) {
      const overlaps = found.some((f) => r.index < f.index + f.text.length && f.index < r.index + r.text.length);
      if (!overlaps) found.push(r);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export function dateCandidates(sources: Source[], reference: Date, lang: string | null): DateCandidate[] {
  const seen = new Set<string>();
  const out: DateCandidate[] = [];
  for (const source of sources) {
    for (const r of parse(source.text, reference, lang)) {
      if (!r.start.isCertain("day") || !r.start.isCertain("month")) continue;
      const [startMs, endMs] = resolve(r, reference);
      const start = iso(startMs);
      const end = endMs !== null && endMs > startMs ? iso(endMs) : null;
      const key = `${start}/${end ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: r.text,
        start,
        end,
        time: r.start.isCertain("hour") ? `${pad(r.start.get("hour")!)}:${pad(r.start.get("minute") ?? 0)}` : null,
        context: sentenceAround(source.text, r.index, r.index + r.text.length),
        origin: source.origin,
        section: source.section,
      });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}
