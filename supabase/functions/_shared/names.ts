import { DeclaredName, sentenceAround, sentences } from "./page.ts";

export const MAX_LENGTH = 60;
export const PRONOUN = /^(?:i|me|you|he|him|she|her|it|its|we|us|they|them|this|that|these|those|who|what|someone|something|everyone|everything)$/i;
export const EDGE_PUNCTUATION = /^[\s"'“”‘’(\[–—:,;.!?…-]+|[\s"'“”‘’)\]–—:,;.!?…-]+$/g;
export const POSSESSIVE_END = /['’]s?$/;
export const ONLY_NUMBERS = /^[\d\s.,$€£%+-]+$/;

// Candidate names in a page's text, from four sources, most certain first:
//  1. names the page declares in its structured data (page.ts);
//  2. names already in `entities` that the text contains, so a known name is
//     found wherever it stands, even opening a sentence or written with a
//     lowercase word inside ("musée d'Orsay");
//  3. runs of capitalised words, joined across particles ("Théâtre du
//     Châtelet", "Parc de l'Etrange"), split at conjunctions ("Paris et
//     Londres" gives both), with a lowercase word in front when that word
//     often opens a name ("galerie Perrotin");
//  4. nothing else: phrases in the title are left to the title's own pass.
//
// Body text is in sentence case, so a capitalised word is a strong hint,
// except at the start of a sentence (ICU's sentence breaks). Whether a word
// there is capitalised for itself is read from the corpus: `caseRates` gives,
// per word, how often it is capitalised when it isn't the first word of a
// sentence (`word_case_stats`, counted from every page read so far). "Dès",
// "Pour", "After", "The" are lowercase mid-sentence, so they are dropped from a
// run's front ("New", sometimes capitalised, is offered with and without);
// "Apple" or "Paris" are names wherever they stand. A word the
// corpus hasn't seen enough falls back to the page itself: alone at a sentence
// start, it counts only if the page also capitalises it mid-sentence. Month
// and weekday names come from Intl for the page's language, not a word list.
//
// A page is too long to ask about everything in it, so at most PAGE_CANDIDATES
// are kept: declared names, then known ones, then rounds over the sections,
// each round adding every section's most frequent phrase not yet taken. A
// guide's entries each get their own names (the event, its venue) before the
// page's most repeated ones crowd them out. Each comes with the sentence it
// first appears in. event-extract also uses it on one entry of a guide at a
// time, to propose that entry's venue.

const PAGE_CANDIDATES = 80;
const KNOWN_CANDIDATES = 25;
const PAGE_MIN_LENGTH = 3;
const CAP_RATE_NAME = 0.5;
// Below this, a capitalised word at a sentence start is never a name's first
// word ("After", "Pour"); above, it sometimes is ("New York").
const NAME_START_RATE = 0.1;
const PREFIX_CAP_RATE = 0.25;
const MAX_PARTICLES = 2;
// Grammar, not data: the little words that sit inside names in the languages
// the feed carries.
const PARTICLES = new Set(["de", "du", "des", "la", "le", "les", "et", "of", "the", "and", "for", "von", "van", "der", "den", "di", "del", "da", "y"]);
const CONJUNCTIONS = new Set(["et", "and"]);
const ELIDED = /^[dlDL]['’](?=\p{Lu})/u;
// A lowercase elided article in front of a name ("d'Orsay") isn't part of it;
// a capital one opening the name ("L'Assaggio", "D'Artagnan") is.
const LOWER_ELIDED = /^[dl]['’](?=\p{Lu})/u;
// The same elision on a folded word, which `name_first_word` (SQL) also drops.
const FOLDED_ELIDED = /^[dl]'(?=\p{L})/u;

// Words as `word_case_counts` (SQL) reads them; keep the two in step.
export const WORD = /\p{L}(?:[\p{L}\p{M}\p{N}'’-]*[\p{L}\p{M}\p{N}])?/gu;
// Tokens: those words, and numbers, which can carry on a name ("Li 6").
const TOKEN = /\p{L}(?:[\p{L}\p{M}\p{N}'’-]*[\p{L}\p{M}\p{N}])?|\p{N}(?:[\p{N}.,]*\p{N})?\p{L}*/gu;
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
const SINGLE_INITIAL = /^\p{Lu}$/u;

export function fold(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").replace(/’/g, "'").toLowerCase()
    .replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss");
}

// Capitalised, or camel-case ("macOS", "xAI"), which is nearly always a name.
function isCapitalised(word: string): boolean {
  const w = word.replace(ELIDED, "");
  return w[0] !== w[0].toLowerCase() || CAMEL_CASE.test(w);
}

export interface PagePhrase {
  surface: string;
  sentence: string;
}

export interface NameHints {
  // fold(word) → how often the corpus capitalises it mid-sentence, for words seen enough.
  caseRates: Map<string, number>;
  known: string[];
  declared: DeclaredName[];
  lang: string | null;
}

interface Token {
  text: string;
  key: string;
  start: number;
  end: number;
  cap: boolean;
  opens: boolean;
  number: boolean;
}

function tokenize(text: string): Token[][] {
  return sentences(text).map(({ start, end }) => {
    const sentence = text.slice(start, end);
    let words = 0;
    return [...sentence.matchAll(TOKEN)].map((m) => {
      const number = !/^\p{L}/u.test(m[0]);
      return {
        text: m[0],
        key: fold(m[0]),
        start: start + m.index!,
        end: start + m.index! + m[0].length,
        cap: !number && isCapitalised(m[0]),
        opens: !number && words++ === 0,
        number,
      };
    });
  });
}

// The distinct words of these texts, for looking up their case rates, and
// those that are capitalised or come just before one, where a known name can
// start.
export function textWords(texts: string[]): { all: string[]; nameStarts: string[] } {
  const all = new Set<string>();
  const nameStarts = new Set<string>();
  for (const text of texts) {
    for (const tokens of tokenize(text)) {
      tokens.forEach((t, i) => {
        if (t.number) return;
        all.add(t.key);
        if (t.cap || tokens[i + 1]?.cap) nameStarts.add(t.key.replace(FOLDED_ELIDED, ""));
      });
    }
  }
  return { all: [...all], nameStarts: [...nameStarts] };
}

const calendarCache = new Map<string, Set<string>>();

// Month and weekday names in `lang` and in English, from Intl.
function calendarWords(lang: string | null): Set<string> {
  const key = lang ?? "";
  let words = calendarCache.get(key);
  if (words) return words;
  words = new Set();
  for (const locale of [lang, "en"]) {
    for (const width of ["long", "short"] as const) {
      let months: Intl.DateTimeFormat, days: Intl.DateTimeFormat;
      try {
        months = new Intl.DateTimeFormat(locale ?? "en", { month: width, timeZone: "UTC" });
        days = new Intl.DateTimeFormat(locale ?? "en", { weekday: width, timeZone: "UTC" });
      } catch {
        continue;
      }
      for (let m = 0; m < 12; m++) words.add(fold(months.format(Date.UTC(2024, m, 1))).replace(/\.$/, ""));
      for (let d = 0; d < 7; d++) words.add(fold(days.format(Date.UTC(2024, 0, 1 + d))).replace(/\.$/, ""));
    }
  }
  calendarCache.set(key, words);
  return words;
}

function cleanSurface(phrase: string): string {
  return phrase.replace(EDGE_PUNCTUATION, "").replace(LOWER_ELIDED, "").replace(POSSESSIVE_END, "").replace(EDGE_PUNCTUATION, "").trim();
}

// Where known names occur among these tokens. A name counts only where the
// page writes it as a name: at least one of its words capitalised, a word the
// name capitalises not lowercase on the page (bar the first: "musée d'Orsay"),
// and a one-word name that is mostly a common word ("Party", "Agent") only
// where it is capitalised mid-sentence. With `caseIsInformative` false (a
// title-case headline) only one-word names that are names wherever they stand
// are taken.
type KnownIndex = Map<string, { words: string[]; caps: boolean[] }[]>;

function knownIndex(known: string[] = []): KnownIndex {
  const byFirst: KnownIndex = new Map();
  for (const name of known) {
    const matches = [...name.matchAll(TOKEN)].map((m) => m[0]);
    if (!matches.length || name.length < PAGE_MIN_LENGTH) continue;
    const words = matches.map((w) => fold(w).replace(FOLDED_ELIDED, ""));
    const list = byFirst.get(words[0]) ?? [];
    list.push({ words, caps: matches.map(isCapitalised) });
    byFirst.set(words[0], list);
  }
  return byFirst;
}

function knownIn(sentencesOf: Token[][], byFirst: KnownIndex, hints: Partial<NameHints>, caseIsInformative: boolean) {
  const found: { tokens: Token[]; sentence: Token[] }[] = [];
  for (const tokens of sentencesOf) {
    tokens.forEach((t, i) => {
      for (const name of byFirst.get(t.key.replace(FOLDED_ELIDED, "")) ?? []) {
        const span = tokens.slice(i, i + name.words.length);
        if (span.length < name.words.length || !span.every((s, j) => s.key.replace(FOLDED_ELIDED, "") === name.words[j])) continue;
        if (!span.some((s) => s.cap) || span.some((s, j) => j > 0 && name.caps[j] && !s.cap)) continue;
        if (span.length === 1) {
          const rate = hints.caseRates?.get(t.key);
          const nameLike = rate === undefined || rate >= CAP_RATE_NAME;
          if (!(nameLike || (caseIsInformative && !t.opens && t.cap))) continue;
        }
        found.push({ tokens: span, sentence: tokens });
      }
    });
  }
  return found;
}

// Known names in a title, for the title's own candidates.
export function knownNamesIn(text: string, hints: Partial<NameHints>): string[] {
  return [...new Set(knownIn(tokenize(text), knownIndex(hints.known), hints, false).map(({ tokens }) =>
    cleanSurface(text.slice(tokens[0].start, tokens[tokens.length - 1].end))))].filter(Boolean);
}

interface Found {
  surface: string;
  count: number;
  sentence: string;
  sections: Set<number>;
  midSentence: boolean;
  source: "declared" | "known" | "run";
}

export function pageCandidates(
  sections: { heading: string | null; text: string }[],
  title: string,
  hints: Partial<NameHints> = {},
  max = PAGE_CANDIDATES,
): PagePhrase[] {
  const inTitle = title.toLowerCase();
  const calendar = calendarWords(hints.lang?.split("-")[0] ?? null);
  const rateOf = (t: Token) => hints.caseRates?.get(t.key);
  const found = new Map<string, Found>();
  const texts = sections.map((section) => [section.heading, section.text].filter(Boolean).join("\n"));
  const known = knownIndex(hints.known);

  const offer = (s: number, text: string, from: number, to: number, midSentence: boolean, source: Found["source"]) => {
    const surface = cleanSurface(text.slice(from, to));
    const key = surface.toLowerCase();
    const words = [...surface.matchAll(WORD)].map((m) => fold(m[0]));
    if (surface.length < PAGE_MIN_LENGTH || surface.length > MAX_LENGTH || ONLY_NUMBERS.test(surface) || PRONOUN.test(surface)) return;
    if (inTitle.includes(key) || !words.length || words.every((w) => calendar.has(w) || PARTICLES.has(w))) return;
    const entry = found.get(key);
    if (entry) {
      entry.count++;
      entry.sections.add(s);
      entry.midSentence ||= midSentence;
    } else {
      found.set(key, { surface, count: 1, sentence: sentenceAround(text, from, to), sections: new Set([s]), midSentence, source });
    }
  };

  const offerRun = (s: number, text: string, tokens: Token[], run: Token[], joins: (a: Token, b: Token) => boolean) => {
    const i = tokens.indexOf(run[0]);
    const first = run[0];
    const rate = rateOf(first);
    const end = run[run.length - 1].end;
    // Other common words capitalised inside the run mean a title-case line
    // ("Meet Your Seoul"), where a capital at the front says nothing either way.
    const titleCase = run.slice(1).some((t) => t.cap && (rateOf(t) ?? 1) < CAP_RATE_NAME);
    const commonFront = rate !== undefined && rate < CAP_RATE_NAME;
    if (!(first.opens && rate !== undefined && rate < NAME_START_RATE && !titleCase)) {
      offer(s, text, first.start, end, !first.opens || run.length > 1 || (rate ?? 0) >= CAP_RATE_NAME, "run");
    }
    // The run without a front word that is lowercase mid-sentence ("The", "Dès"), or unseen at a sentence start.
    if (run.length > 1 && (rate === undefined ? first.opens : commonFront)) {
      const r = run.findIndex((t, j) => j > 0 && t.cap);
      if (r > 0) offer(s, text, run[r].start, end, true, "run");
    }
    // Parts joined by a conjunction, without their leading particles.
    const parts: Token[][] = [[]];
    run.forEach((t, r) => {
      if (!t.cap && CONJUNCTIONS.has(t.key)) parts.push([]);
      else {
        if (r > 0 && text.slice(run[r - 1].end, t.start).includes("&")) parts.push([]);
        parts[parts.length - 1].push(t);
      }
    });
    const trimmed = parts.map((part) => part.slice(Math.max(0, part.findIndex((t) => t.cap)))).filter((part) => part.length);
    if (trimmed.length > 1) {
      for (const part of trimmed) offer(s, text, part[0].start, part[part.length - 1].end, true, "run");
    }
    // With the lowercase word in front that often opens a name ("musée d'Orsay", "galerie Perrotin").
    let p = i - 1;
    while (p >= 0 && i - p <= MAX_PARTICLES && !tokens[p].cap && PARTICLES.has(tokens[p].key) && joins(tokens[p], tokens[p + 1])) p--;
    if (p >= 0 && !tokens[p].cap && !tokens[p].number && (rateOf(tokens[p]) ?? 0) >= PREFIX_CAP_RATE && joins(tokens[p], tokens[p + 1])) {
      const head = trimmed[0];
      offer(s, text, tokens[p].start, head[head.length - 1].end, true, "run");
    }
  };

  texts.forEach((text, s) => {
    const sentencesOf = tokenize(text);
    // Two tokens are one name's neighbours when only spaces (or "&", or an
    // initial's full stop: "C. Thi Nguyen") stand between them.
    const joins = (a: Token, b: Token) =>
      /^\s+$|^\s*&\s*$/.test(text.slice(a.end, b.start)) || (SINGLE_INITIAL.test(a.text) && /^\.\s+$/.test(text.slice(a.end, b.start)));
    // Where each token's run of capitalised words ends, so a known name inside
    // a longer one ("Levin" in "Mylo Levin") isn't offered on its own.
    const runsBySentence = sentencesOf.map((tokens) => {
      const runs: Token[][] = [];
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].cap) continue;
        // Capitalised words, up to MAX_PARTICLES particles between two of them, and numbers after them.
        let last = i;
        for (let j = i + 1; j < tokens.length;) {
          let k = j;
          while (k < tokens.length && k - j < MAX_PARTICLES && !tokens[k].cap && PARTICLES.has(tokens[k].key) && joins(tokens[k - 1], tokens[k])) k++;
          if (k < tokens.length && (tokens[k].cap || (tokens[k].number && k === j)) && joins(tokens[k - 1], tokens[k])) {
            last = k;
            j = k + 1;
          } else break;
        }
        runs.push(tokens.slice(i, last + 1));
        i = last;
      }
      return runs;
    });
    const runOf = new Map<Token, Token[]>();
    for (const run of runsBySentence.flat()) for (const t of run) runOf.set(t, run);
    for (const { tokens } of knownIn(sentencesOf, known, hints, true)) {
      const run = runOf.get(tokens[0]);
      const inside = run && run.length > tokens.length && run.includes(tokens[tokens.length - 1]) &&
        run.filter((t) => t.cap).length > tokens.filter((t) => t.cap).length;
      if (!inside) offer(s, text, tokens[0].start, tokens[tokens.length - 1].end, true, "known");
    }
    sentencesOf.forEach((tokens, n) => {
      for (const full of runsBySentence[n]) {
        // A name runs on into numbers ("Li 6"); it is offered with and without them.
        let words = full.length;
        while (words > 1 && full[words - 1].number) words--;
        const variants = words < full.length ? [full, full.slice(0, words)] : [full];
        for (const run of variants) offerRun(s, text, tokens, run, joins);
      }
    });
  });

  const taken = new Set<Found>();
  for (const name of hints.declared ?? []) {
    if (taken.size >= max) break;
    const key = name.name.toLowerCase();
    if (inTitle.includes(key) || name.name.length > MAX_LENGTH) continue;
    const entry = found.get(key) ?? {
      surface: name.name,
      count: 1,
      sentence: `The page's structured data (schema.org) names "${name.name}" as a ${name.type}.`,
      sections: new Set<number>(),
      midSentence: true,
      source: "declared" as const,
    };
    taken.add(entry);
  }
  const all = [...found.values()].filter((f) => f.midSentence).sort((a, b) => b.count - a.count);
  for (const known of all.filter((f) => f.source === "known").slice(0, KNOWN_CANDIDATES)) {
    if (taken.size >= max) break;
    taken.add(known);
  }
  const bySection = sections.map((_, s) => all.filter((f) => f.sections.has(s)));
  for (let added = true; added && taken.size < max;) {
    added = false;
    for (const list of bySection) {
      const next = list.find((f) => !taken.has(f));
      if (!next || taken.size >= max) continue;
      taken.add(next);
      added = true;
    }
  }
  return [...taken].map(({ surface, sentence }) => ({ surface, sentence }));
}
