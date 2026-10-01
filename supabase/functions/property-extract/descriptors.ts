import nlp from "npm:compromise@14.14.4";

// The words a title uses to describe an entity, found by compromise without a
// model call: the run of words just before the entity's name ("British AI
// neocloud Nscale"), or an appositive after it ("Nscale, a British AI
// neocloud,"). A run stops at a verb, determiner, preposition, conjunction,
// pronoun, possessive (that's a relation, not a property) or punctuation, and
// skips over another entity's name ("former NFL coach Mike Tomlin" gives
// "former coach"). Hyphenated pieces are rejoined ("2-month-old"). "former"
// and its kin are a time qualifier, not a description, so they set `former`
// rather than becoming a word.
//
// Headlines are title case, which makes compromise read verbs as nouns
// ("Anthropic Releases"), so capitalised words outside entity names are
// lowercased before tagging, and two headline verb shapes it still misses stop a
// run: an -s word right after another entity ("Pentagon taps Elon Musk") and an
// -ing word that isn't the first word ("Google ending ChromeOS").

const STOP_TAGS = ["Verb", "Determiner", "Preposition", "Conjunction", "Pronoun", "Possessive", "QuestionWord", "Copula", "Modal", "Auxiliary", "Value", "Adverb", "Negative"];
// Function words compromise sometimes tags as nouns ("the city of Rafah").
const FUNCTION_WORD = /^(?:of|in|on|at|to|for|from|with|by|about|as|into|over|after|and|or|but|not|vs)$/i;
const APPOSITIVE_START = /^(?:a|an|the)$/i;
const FORMER = /^(?:former|ex|onetime|then)$/i;
const BREAKING_PUNCTUATION = /[,:;()|"“”–—!?]|\.(?:\s|$)/;
const TITLE_CASE_WORD = /\b[A-Z][a-z]+\b/g;
const THIRD_PERSON_VERB = /^[a-z]+[^s]s$/;
const GERUND = /^[a-z]+ing$/;
const POSSESSIVE_SUFFIX = /['’]s?$/;
const MAX_WORDS = 5;

interface Term {
  text: string;
  tags: string[];
  post: string;
}

export interface Descriptor {
  surface: string;
  words: string[];
  former: boolean;
}

// Lowercases title-case words outside the given names, so compromise tags the
// headline as a sentence.
function sentenceCase(title: string, surfaces: string[]): string {
  const lower = title.toLowerCase();
  const kept = surfaces.flatMap((s) => {
    const at = lower.indexOf(s.toLowerCase());
    return at < 0 ? [] : [[at, at + s.length]];
  });
  return title.replace(TITLE_CASE_WORD, (word, at: number) =>
    kept.some(([from, to]) => at >= from && at < to) ? word : word.toLowerCase());
}

function terms(title: string): Term[] {
  const raw: Term[] = nlp(title).terms().json().map((t: { terms: { text: string; tags: string[]; post: string }[] }) => ({
    text: t.terms[0].text,
    tags: t.terms[0].tags,
    post: t.terms[0].post,
  }));
  const joined: Term[] = [];
  for (const term of raw) {
    const prev = joined[joined.length - 1];
    if (prev && prev.post.trim() === "-" && !/\s/.test(prev.post)) {
      prev.text = `${prev.text}-${term.text}`;
      prev.tags = term.tags.includes("Possessive") ? ["Possessive"] : [];
      prev.post = term.post;
    } else {
      joined.push({ ...term });
    }
  }
  return joined;
}

const norm = (text: string) => text.replace(POSSESSIVE_SUFFIX, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function findSpan(ts: Term[], surface: string): [number, number] | null {
  const target = norm(surface);
  if (!target) return null;
  for (let i = 0; i < ts.length; i++) {
    let acc = "";
    for (let j = i; j < ts.length && acc.length < target.length; j++) {
      acc += norm(ts[j].text);
      if (acc === target) return [i, j];
    }
  }
  return null;
}

const stops = (t: Term) =>
  !t.text || POSSESSIVE_SUFFIX.test(t.text) || FUNCTION_WORD.test(t.text) || t.tags.some((tag) => STOP_TAGS.includes(tag));

export function descriptors(title: string, surfaces: string[]): Descriptor[] {
  const ts = terms(sentenceCase(title, surfaces));
  const spans = surfaces.map((s) => findSpan(ts, s));
  const inOtherSpan = (k: number, own: number) =>
    spans.some((span, i) => i !== own && span && k >= span[0] && k <= span[1]);
  const out: Descriptor[] = [];

  spans.forEach((span, own) => {
    if (!span) return;
    const words: string[] = [];
    let former = false;
    const take = (t: Term) => {
      if (FORMER.test(t.text)) former = true;
      else words.push(t.text);
    };

    const before: Term[] = [];
    for (let k = span[0] - 1; k >= 0 && before.length < MAX_WORDS; k--) {
      const t = ts[k];
      if (BREAKING_PUNCTUATION.test(t.post) || stops(t)) break;
      if (inOtherSpan(k, own)) continue;
      if ((THIRD_PERSON_VERB.test(t.text) && inOtherSpan(k - 1, own)) || (GERUND.test(t.text) && k > 0)) break;
      before.unshift(t);
    }
    before.forEach(take);

    const last = ts[span[1]];
    const next = ts[span[1] + 1];
    if (!words.length && last.post.includes(",") && next && APPOSITIVE_START.test(next.text)) {
      for (let k = span[1] + 2; k < ts.length && words.length < MAX_WORDS; k++) {
        const t = ts[k];
        if (stops(t) || inOtherSpan(k, own)) break;
        take(t);
        if (BREAKING_PUNCTUATION.test(t.post)) break;
      }
    }

    if (words.length) out.push({ surface: surfaces[own], words, former });
  });
  return out;
}
