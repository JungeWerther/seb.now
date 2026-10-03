import nlp from "npm:compromise@14.14.4";
import { sentenceAround } from "../_shared/page.ts";

// Candidate phrases that might name an entity. Recall matters more than
// precision here: Jev decides which candidates are names, and it can only
// choose among what it is shown. So each noun chunk is offered whole and split
// at connecting words and possessives ("Cerebras Systems’ Andrew Feldman" gives
// the whole and both halves), and every run of capitalised words is offered too,
// since compromise's own name detection misses most tech names, and so is every
// camel-case word (LinkedIn, DoorDash), which is nearly always a name. A long
// capitalised run in a title-case headline swallows names ("Interview Craig
// Federighi Regarding"), so each two-word window of it is offered as well.
// A phrase with a possessive inside ("Google’s Project Suncatcher") is dropped:
// its halves are already offered on their own.

const MAX_CANDIDATES = 20;
const MIN_LENGTH = 2;
const MAX_LENGTH = 60;
const LEADING_WORDS =
  /^(?:(?:a|an|the|my|your|our|their|its|his|her|some|this|that|these|those|all|every|no|new|how|why|what|one|two|three|four|five|six|seven|eight|nine|ten)\s+)+/i;
const PRONOUN = /^(?:i|me|you|he|him|she|her|it|its|we|us|they|them|this|that|these|those|who|what|someone|something|everyone|everything)$/i;
const EDGE_PUNCTUATION = /^[\s"'“”‘’(\[–—:,;.!?…-]+|[\s"'“”‘’)\]–—:,;.!?…-]+$/g;
const POSSESSIVE_END = /['’]s?$/;
const SPLIT_AT =
  /\s+(?:and|&|or|vs\.?|versus|of|in|on|at|for|from|with|by|to|about|as|into|over|after)\s+|['’]s?\s+|\s*[–—:;,()|]\s*|\s+-\s+/i;
const CAPITALISED_RUN = /(?:[A-Z0-9][\w.+’'-]*|[a-z]+[A-Z][\w.+-]*)(?:\s+(?:[A-Z0-9][\w.+’'-]*|[a-z]+[A-Z][\w.+-]*))*/g;
const ONLY_NUMBERS = /^[\d\s.,$€£%+-]+$/;
const LEADING_NUMBER = /^(?:[\d$€£][\w.,$€£%]*\s+)+/;
const CAMEL_CASE_WORD = /\b[A-Za-z]*[a-z][A-Z][\w]*\b/g;
const INNER_POSSESSIVE = /['’]s?\s/;
const WINDOW_MIN_RUN_WORDS = 3;

export function clean(phrase: string): string {
  return phrase
    .replace(EDGE_PUNCTUATION, "")
    .replace(LEADING_WORDS, "")
    .replace(POSSESSIVE_END, "")
    .replace(LEADING_NUMBER, "")
    .replace(EDGE_PUNCTUATION, "")
    .trim();
}

function pairs(run: string): string[] {
  const words = run.split(/\s+/);
  if (words.length < WINDOW_MIN_RUN_WORDS) return [];
  return words.slice(1).map((word, i) => `${words[i]} ${word}`);
}

export function candidates(title: string): string[] {
  const chunks: string[] = nlp(title).nouns().out("array");
  const runs = title.match(CAPITALISED_RUN) ?? [];
  const raw = [
    ...chunks.flatMap((chunk) => [chunk, ...chunk.split(SPLIT_AT)]),
    ...runs,
    ...(title.match(CAMEL_CASE_WORD) ?? []),
    ...runs.flatMap(pairs),
  ].filter((phrase) => !INNER_POSSESSIVE.test(phrase.trim()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const phrase of raw.map(clean)) {
    const key = phrase.toLowerCase();
    const unbalanced = (phrase.match(/\(/g)?.length ?? 0) !== (phrase.match(/\)/g)?.length ?? 0);
    if (phrase.length < MIN_LENGTH || phrase.length > MAX_LENGTH || ONLY_NUMBERS.test(phrase) || PRONOUN.test(phrase) || unbalanced || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(phrase);
  }
  return out.slice(0, MAX_CANDIDATES);
}

// Candidate names in a page's text. Body text is in sentence case, so a run of
// capitalised words (joined across particles: "Théâtre du Châtelet", "Parc de
// l'Etrange") is already a strong hint, as is a capitalised name after a
// lowercase venue word ("musée d'Orsay", "galerie Perrotin"). A run joining two
// names ("Paris et Londres") is offered whole and split. A single word that
// only ever opens a sentence ("Dès", "Pour") is just a capital letter. Phrases
// in the title are left to the title's own pass.
//
// A page is too long to ask about everything in it, so at most PAGE_CANDIDATES
// are kept, taken in rounds over the sections: each round adds every section's
// most frequent phrase not yet taken. A guide's entries each get their own
// names (the event, its venue) before the page's most repeated ones crowd them
// out. Each comes with the sentence it first appears in.

const PAGE_CANDIDATES = 60;
const PAGE_MIN_LENGTH = 3;
const NAME_WORD = String.raw`\p{Lu}(?:[\p{L}\p{M}\p{N}&-]|['’.](?=\p{L}))*`;
const PARTICLE = String.raw`(?:de|du|des|la|le|les|et|of|the|and|for|von|van|der|den|di|del|da|y)`;
const JOIN = String.raw`[ \u00a0]+(?:${PARTICLE}[ \u00a0]+){0,2}(?:[dl]['’])?`;
const VENUE_WORD =
  String.raw`(?:musée|théâtre|galerie|parc|jardin|église|institut|centre|maison|palais|salle|cinéma|château|place|pavillon|fondation|bibliothèque|cité|halle|opéra|museum|gallery|theatre|theater|park|church|hall)`;
const PAGE_NAME = new RegExp(String.raw`(?:(?<!\p{L})${VENUE_WORD}${JOIN})?${NAME_WORD}(?:${JOIN}${NAME_WORD})*`, "gu");
const CONJUNCTION = /\s+(?:et|and|&)\s+/;
const LEADING_ARTICLE = /^(?:(?:Le|La|Les|The|Un|Une|A|An)\s+|[LD]['’])/u;
// A preposition opening a sentence is capitalised but never starts a name.
const LEADING_PREPOSITION = /^(?:Dans|En|Pour|Avec|Chez|Depuis|Sur|Sous|Après|Avant|Entre|Vers|Par|Selon|Dès|In|At|On|For|From|With|By|After|Before|During|Since)\s+/u;
const SENTENCE_START = /(?:^|[.!?:»"“\[(]\s*|\n|\s-\s)$/;
const CALENDAR_WORD =
  /^(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+(?:er|e|st|nd|rd|th)?)$/i;
const PARTICLE_WORD = new RegExp(String.raw`^(?:${PARTICLE}|[dl]['’].*)$`, "iu");
const LEADING_PARTICLES = new RegExp(String.raw`^(?:${PARTICLE}\s+)+`, "u");

export interface PagePhrase {
  surface: string;
  sentence: string;
}

interface Found {
  surface: string;
  count: number;
  sentence: string;
  sections: Set<number>;
  midSentence: boolean;
}

export function pageCandidates(sections: { heading: string | null; text: string }[], title: string): PagePhrase[] {
  const inTitle = title.toLowerCase();
  const found = new Map<string, Found>();
  sections.forEach((section, s) => {
    const text = [section.heading, section.text].filter(Boolean).join("\n");
    const offer = (phrase: string, index: number, end: number, opensSentence: boolean) => {
      // Not `clean`: its leading words ("new", "one") start names in prose ("New York").
      const surface = phrase.replace(EDGE_PUNCTUATION, "").replace(LEADING_PREPOSITION, "").replace(LEADING_PARTICLES, "").replace(POSSESSIVE_END, "").replace(EDGE_PUNCTUATION, "").trim();
      const key = surface.toLowerCase();
      const words = surface.split(/\s+/);
      if (surface.length < PAGE_MIN_LENGTH || surface.length > MAX_LENGTH || ONLY_NUMBERS.test(surface) || PRONOUN.test(surface)) return;
      if (inTitle.includes(key) || words.every((w) => CALENDAR_WORD.test(w) || PARTICLE_WORD.test(w))) return;
      const midSentence = !opensSentence || phrase.trim().split(/\s+/).length > 1;
      const entry = found.get(key);
      if (entry) {
        entry.count++;
        entry.sections.add(s);
        entry.midSentence ||= midSentence;
      } else {
        found.set(key, { surface, count: 1, sentence: sentenceAround(text, index, end), sections: new Set([s]), midSentence });
      }
    };
    for (const match of text.matchAll(PAGE_NAME)) {
      const run = match[0];
      const index = match.index!;
      const end = index + run.length;
      offer(run, index, end, SENTENCE_START.test(text.slice(Math.max(0, index - 3), index)));
      if (LEADING_ARTICLE.test(run)) offer(run.replace(LEADING_ARTICLE, ""), index, end, false);
      if (CONJUNCTION.test(run)) run.split(CONJUNCTION).forEach((part) => offer(part, index, end, false));
    }
  });

  const ranked = [...found.values()].filter((f) => f.midSentence).sort((a, b) => b.count - a.count);
  const bySection = sections.map((_, s) => ranked.filter((f) => f.sections.has(s)));
  const taken = new Set<Found>();
  for (let added = true; added && taken.size < PAGE_CANDIDATES;) {
    added = false;
    for (const list of bySection) {
      const next = list.find((f) => !taken.has(f));
      if (!next || taken.size >= PAGE_CANDIDATES) continue;
      taken.add(next);
      added = true;
    }
  }
  return [...taken].map(({ surface, sentence }) => ({ surface, sentence }));
}
