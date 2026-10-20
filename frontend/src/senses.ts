// What the words typed in the search box name, as tagTokens tags them.
//
// A script like filter.ts (no imports or exports; tsc compiles it to
// src/seb_now/templates/senses.js, which site.py inlines at SENSES_JS_PLACEHOLDER).
// Keep it free of page globals: folding words and matching them come in as
// arguments.
//
// Two rules, both about not choosing for the reader:
// - A name stands for every sense it has at once (a superposition, as in
//   typedFilter): an entity "Event", the kind Event and a film called "Event"
//   are one entry with three senses, never whichever was listed first.
// - A word still being typed is a guess at a name, not a reading of one. It
//   only completes a name when no other name could take it: "nightc" may be
//   "Nightcall", "night" may be Nightcall, Night Owl or Night Vale, so it
//   names none of them yet.

// Between a name's folded words, and between a kind path's labels.
const NAME_WORD_SEPARATOR = " ";
const KIND_PATH_SEPARATOR = ".";

// One name and every sense its words have, the words folded.
interface LexEntry<S> {
  words: string[];
  senses: S[];
}

// The named things grouped by their folded words, longest names first (a
// stable sort, so equal lengths keep their order), so "tim fernholz" is one
// name before "tim" can take its first word. Names that fold to nothing are
// dropped; a sense repeated under one name (a kind typed by its label and by
// its path, "Event" and "event") is kept once, by `senseId`.
function lexicon<S>(
  named: readonly { name: string; sense: S }[],
  fold: (name: string) => string[],
  senseId: (sense: S) => string,
): LexEntry<S>[] {
  const entries = new Map<string, LexEntry<S> & { ids: Set<string> }>();
  for (const { name, sense } of named) {
    const words = fold(name);
    if (!words.length) continue;
    const key = words.join(NAME_WORD_SEPARATOR);
    const entry = entries.get(key) ?? { words, senses: [], ids: new Set<string>() };
    entries.set(key, entry);
    const id = senseId(sense);
    if (entry.ids.has(id)) continue;
    entry.ids.add(id);
    entry.senses.push(sense);
  }
  return [...entries.values()]
    .map(({ words, senses }) => ({ words, senses }))
    .sort((a, b) => b.words.length - a.words.length);
}

// A typed word: folded, whether it's the one still being typed, and whether
// an earlier reading (a sort word, the reading's topic) has already taken it.
interface TypedWord {
  word: string;
  partial: boolean;
  open: boolean;
}

// A name the typed words cover, and which of them (indexes into the words).
interface Claim<S> {
  entry: LexEntry<S>;
  at: number[];
}

type WordMatch = (typed: string, nameWord: string, partial: boolean) => boolean;

// The open words covering every word of `entry`, or null if one isn't typed.
// With `complete`, the word still being typed may cover a longer name word.
function coverName<S>(
  typed: readonly TypedWord[],
  open: readonly boolean[],
  entry: LexEntry<S>,
  matches: WordMatch,
  complete: boolean,
): number[] | null {
  const hit = (i: number, n: string) => {
    const t = typed[i];
    return t !== undefined && matches(t.word, n, complete && t.partial);
  };
  const at = typed.flatMap((_, i) => (open[i] && entry.words.some((n) => hit(i, n)) ? [i] : []));
  return entry.words.every((n) => at.some((i) => hit(i, n))) ? at : null;
}

// The names `typed` reads, each with the words it takes. Whole words first,
// longest names first, each name taking its words from the ones after it.
// Then, with `complete`, the word still being typed may finish a name, but
// only when exactly one name could: a prefix shared by several names is no
// reading yet.
function claimNames<S>(
  typed: readonly TypedWord[],
  entries: readonly LexEntry<S>[],
  matches: WordMatch,
  complete: boolean,
): Claim<S>[] {
  const open = typed.map((t) => t.open);
  const claims: Claim<S>[] = [];
  for (const entry of entries) {
    const at = coverName(typed, open, entry, matches, false);
    if (!at) continue;
    for (const i of at) open[i] = false;
    claims.push({ entry, at });
  }
  if (!complete) return claims;
  const completions = entries.flatMap((entry) => {
    const at = coverName(typed, open, entry, matches, true);
    return at?.some((i) => typed[i]?.partial) ? [{ entry, at }] : [];
  });
  const [only] = completions;
  return completions.length === 1 && only ? [...claims, only] : claims;
}

// The kind every path is under: "entity.artifact.work" and
// "entity.artifact.product" are both artifacts. Null for no paths, or when
// one of them is outside the kind tree (a topic).
function commonKindPath(paths: readonly (string | null)[]): string | null {
  const [first, ...rest] = paths.map((p) => p?.split(KIND_PATH_SEPARATOR));
  if (!first || rest.some((p) => !p)) return null;
  let depth = first.length;
  for (const p of rest) {
    let same = 0;
    while (same < depth && p?.[same] === first[same]) same++;
    depth = same;
  }
  return depth ? first.slice(0, depth).join(KIND_PATH_SEPARATOR) : null;
}

// A tag's label for a name's senses: one sense reads as its label ("work");
// several read as what they share, with how many ("work ×2", "artifact ×3"),
// or "senses ×n" when they share nothing in the kind tree (a topic and a
// kind). `name` turns a kind path into its short name.
const SENSES_LABEL = "senses";
const SENSE_COUNT_SEPARATOR = " ×";

function senseLabel(
  senses: readonly { label: string; path: string | null }[],
  name: (path: string) => string,
): string {
  const [one, ...more] = senses;
  if (!one) return "";
  if (!more.length) return one.label;
  const labels = new Set(senses.map((s) => s.label));
  const common = commonKindPath(senses.map((s) => s.path));
  const shared = labels.size === 1 ? one.label : common ? name(common) : SENSES_LABEL;
  return [shared, String(senses.length)].join(SENSE_COUNT_SEPARATOR);
}
