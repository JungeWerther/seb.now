// Which names in a pass stand for something themselves, and which are only
// words inside a longer name ("Tokyo" in "Palais de Tokyo", "Louis Vuitton" in
// "Fondation Louis Vuitton"). The text decides, not the names: a name is a
// fragment when every place the text says it is inside a longer name read as
// whole. A fragment is never a mention of its own: if it meant the longer
// name's thing, that is already a mention, and if it didn't, it isn't one.

export interface Span {
  surface: string;
}

// A name's words, for finding the same name inside a longer one: case, curly
// apostrophes and a possessive 's don't count.
export function nameWords(surface: string): string[] {
  return surface.toLowerCase().replace(/’/g, "'").replace(/'s\b/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Where `name`'s words start in `words`.
function occurrences(words: string[], name: string[]): number[] {
  if (!name.length) return [];
  return words.flatMap((_, i) => (i + name.length <= words.length && name.every((w, j) => words[i + j] === w) ? [i] : []));
}

// Whether `longer`'s words hold `shorter`'s, in order, and more besides.
export function containsName(longer: string[], shorter: string[]): boolean {
  return shorter.length < longer.length && occurrences(longer, shorter).length > 0;
}

export const contains = (longer: Span, shorter: Span): boolean =>
  containsName(nameWords(longer.surface), nameWords(shorter.surface));

// A name never runs across a sentence end or a line break. A period after an
// initial or a short capitalised abbreviation ("C. Thi Nguyen", "Dr. Smith",
// "U.S. Army") doesn't end a sentence.
const BOUNDARY =
  /(?<!(?:^|[^\p{L}])(?:\p{Lu}|Dr|Mr|Mrs|Ms|Mme|Mlle|St|Ste|Jr|Sr|Prof|Gen|Gov|Sen|Rep|Lt|Col|Capt|Inc|Ltd|Co|Corp|vs|No))\.+(?:\s+|$)|[!?;]+(?:\s+|$)|\n+/u;

// Whether `text` says `name` anywhere outside every one of `wholes`, reading
// sentence by sentence so a name is never matched across a boundary ("New York.
// Times are hard" holds no "New York Times"). A name the text doesn't say as
// such (spelled otherwise) is taken to stand alone.
export function standsAlone(name: string, wholes: string[], text: string): boolean {
  const own = nameWords(name);
  const holders = wholes.map(nameWords).filter((whole) => containsName(whole, own));
  let said = false;
  for (const segment of text.split(BOUNDARY)) {
    const words = nameWords(segment);
    const covered = holders.flatMap((whole) => occurrences(words, whole).map((start) => [start, start + whole.length] as const));
    for (const i of occurrences(words, own)) {
      said = true;
      if (!covered.some(([start, end]) => start <= i && i + own.length <= end)) return true;
    }
  }
  return !said;
}

// The names of `names` that only ever appear inside one of `wholes` in `text`.
export function fragments<N extends Span>(names: N[], wholes: Span[], text: string): N[] {
  return names.filter((name) => {
    const holders = wholes.filter((whole) => contains(whole, name));
    return holders.length > 0 && !standsAlone(name.surface, holders.map((h) => h.surface), text);
  });
}

export interface SpanReading<N extends Span> {
  kept: N[];
  // Names that ran several things together, so their parts were read instead.
  runTogether: N[];
  // Names that were only part of a longer name.
  parts: N[];
}

// Reads a pass's names once it is known which longer names run several things
// together (`isRunTogether`, asked only of names holding a fragment):
// those are dropped and their parts kept; any other fragment is dropped.
// `context` are names already read whole elsewhere (the title, for a page).
export async function readSpans<N extends Span>(
  names: N[],
  context: Span[],
  text: string,
  isRunTogether: (holders: { name: N; parts: N[] }[]) => Promise<Set<N>>,
): Promise<SpanReading<N>> {
  const found = fragments(names, [...names, ...context], text);
  if (!found.length) return { kept: names, runTogether: [], parts: [] };
  const holders = names
    .map((name) => ({ name, parts: found.filter((part) => contains(name, part)) }))
    .filter(({ parts }) => parts.length);
  const runTogether = holders.length ? await isRunTogether(holders) : new Set<N>();
  const remaining = names.filter((name) => !runTogether.has(name));
  const parts = new Set(fragments(remaining, [...remaining, ...context], text));
  return {
    kept: remaining.filter((name) => !parts.has(name)),
    runTogether: names.filter((name) => runTogether.has(name)),
    parts: [...parts],
  };
}

// A page's declared language isn't always a valid locale ("en_US"); then the
// default one reads its sentences.
function sentenceSegmenter(lang?: string | null): Intl.Segmenter {
  try {
    return new Intl.Segmenter(lang ?? undefined, { granularity: "sentence" });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
}

// The first sentence of `text` that says `surface` outside every one of
// `wholes` (the sentence that makes it stand alone), else null.
export function aloneSentence(text: string, surface: string, wholes: string[], lang?: string | null): string | null {
  for (const { segment } of sentenceSegmenter(lang).segment(text)) {
    if (occurrences(nameWords(segment), nameWords(surface)).length && standsAlone(surface, wholes, segment)) return segment.trim();
  }
  return null;
}

// The first sentence of `text` that says `surface`, for asking about a name
// read back from storage.
export function sentenceWith(text: string, surface: string, lang?: string | null): string | null {
  const own = nameWords(surface);
  for (const { segment } of sentenceSegmenter(lang).segment(text)) {
    if (occurrences(nameWords(segment), own).length) return segment.trim();
  }
  return null;
}
