import nlp from "npm:compromise@14.14.4";
import { EDGE_PUNCTUATION, MAX_LENGTH, ONLY_NUMBERS, POSSESSIVE_END, PRONOUN } from "../_shared/names.ts";

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
const LEADING_WORDS =
  /^(?:(?:a|an|the|my|your|our|their|its|his|her|some|this|that|these|those|all|every|no|new|how|why|what|one|two|three|four|five|six|seven|eight|nine|ten)\s+)+/i;
const SPLIT_AT =
  /\s+(?:and|&|or|vs\.?|versus|of|in|on|at|for|from|with|by|to|about|as|into|over|after)\s+|['’]s?\s+|\s*[–—:;,()|]\s*|\s+-\s+/i;
const CAPITALISED_RUN = /(?:[A-Z0-9][\w.+’'-]*|[a-z]+[A-Z][\w.+-]*)(?:\s+(?:[A-Z0-9][\w.+’'-]*|[a-z]+[A-Z][\w.+-]*))*/g;
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
