// A link's page reduced to what a reader would read, without a DOM parser
// (a full parse of a 1 MB page costs more CPU than an edge function gets):
// the chrome around the text (scripts, menus, headers, footers, forms) is cut
// out, everything before the page's own <h1> is dropped, and the rest becomes
// plain text split into sections at its <h2>/<h3> headings, or at paragraphs
// that open with a bold title. A guide listing several events usually gives
// each one its own heading or bold title, so each section can be read as one
// event. schema.org Event objects declared in JSON-LD are kept as they are,
// since they need no reading at all.
//
// entity-extract fetches each page once and keeps the text in `link_content`;
// event-extract reads it back from there with `parseSections`.

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; seb.now reader; +https://seb.now)";

const CHROME_TAGS = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "header", "footer", "aside", "form", "button", "select"];
const BLOCK_TAG = /<\/?(?:p|div|li|ul|ol|tr|td|th|table|section|article|main|blockquote|dd|dt|dl|figure|figcaption|h[4-6])\b[^>]*>|<br\s*\/?>/gi;
const SECTION_HEADING = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
// A paragraph that opens with a bold title ("<p><a><strong>Meet Your
// Seoul…</strong></a><br>Du 6 au 27 octobre…"), the shape of an entry in a
// listing without headings; a short bold lead-in ("À noter :") is emphasis.
const BOLD_ENTRY = /<p\b[^>]*>\s*((?:<a\b[^>]*>\s*)?(?:<img\b[^>]*>\s*)*)<(strong|b)\b[^>]*>([\s\S]*?)<\/\2>/gi;
const ENTRY_TITLE_MIN_CHARS = 12;
const ENTRY_TITLE_MAX_CHARS = 200;
const JSON_LD = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const EVENT_TYPE = /Event$|^Festival$/;

export interface Section {
  heading: string | null;
  text: string;
}

export interface JsonLdEvent {
  type: string;
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
}

export interface PageContent {
  status: number | null;
  lang: string | null;
  sections: Section[];
  jsonLdEvents: JsonLdEvent[];
}

// The named entities European-language pages use; numeric ones are decoded generally.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  ndash: "–", mdash: "—", hellip: "…", middot: "·", euro: "€", deg: "°",
  aacute: "á", agrave: "à", acirc: "â", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  ntilde: "ñ", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", oslash: "ø", oelig: "œ",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", yuml: "ÿ", szlig: "ß",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Auml: "Ä", Ccedil: "Ç", Eacute: "É", Egrave: "È", Ecirc: "Ê",
  Icirc: "Î", Ocirc: "Ô", Ouml: "Ö", OElig: "Œ", Ucirc: "Û", Uuml: "Ü",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (whole, name) => NAMED_ENTITIES[name] ?? whole);
}

function toText(html: string): string {
  return decodeEntities(html.replace(BLOCK_TAG, "\n").replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function stripChrome(html: string): string {
  let out = html;
  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  return out;
}

function placeName(location: unknown): string | null {
  const first = Array.isArray(location) ? location[0] : location;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string") {
    return (first as { name: string }).name;
  }
  return null;
}

function jsonLdEvents(html: string): JsonLdEvent[] {
  const events: JsonLdEvent[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(obj["@type"] ?? []);
    const type = types.find((t): t is string => typeof t === "string" && EVENT_TYPE.test(t));
    if (type) {
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? decodeEntities(v.trim()) : null);
      events.push({ type, name: str(obj.name), startDate: str(obj.startDate), endDate: str(obj.endDate), location: placeName(obj.location) });
    }
    if (obj["@graph"]) visit(obj["@graph"]);
  };
  for (const match of html.matchAll(JSON_LD)) {
    try {
      visit(JSON.parse(match[1].trim()));
    } catch {
      // A malformed block is the page's own bug; the rest of the page still counts.
    }
  }
  return events;
}

export function readPage(html: string): Omit<PageContent, "status"> {
  const lang = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? null;
  const events = jsonLdEvents(html);
  // Cut at the <h1> before stripping: article templates often put it inside a <header>.
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  const h1 = body.search(/<h1\b/i);
  if (h1 >= 0) body = body.slice(body.indexOf(">", h1) + 1).replace(/<\/h1>/i, "\n");
  body = stripChrome(body).replace(BOLD_ENTRY, (whole, before, _tag, title) => {
    const length = toText(title).length;
    return length >= ENTRY_TITLE_MIN_CHARS && length <= ENTRY_TITLE_MAX_CHARS ? `<h3>${title}</h3><p>${before}` : whole;
  });

  const sections: Section[] = [];
  let heading: string | null = null;
  let last = 0;
  let total = 0;
  const push = (html: string) => {
    const text = toText(html).slice(0, Math.max(0, MAX_TEXT_CHARS - total));
    total += text.length;
    if (text || heading) sections.push({ heading, text });
  };
  for (const match of body.matchAll(SECTION_HEADING)) {
    push(body.slice(last, match.index));
    heading = toText(match[2]).replace(/\n/g, " ") || null;
    last = match.index! + match[0].length;
    if (total >= MAX_TEXT_CHARS) break;
  }
  if (total < MAX_TEXT_CHARS) push(body.slice(last));
  return { lang, sections, jsonLdEvents: events };
}

export async function fetchPage(url: string): Promise<PageContent> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      await res.body?.cancel();
      return { status: res.status, lang: null, sections: [], jsonLdEvents: [] };
    }
    return { status: res.status, ...readPage((await res.text()).slice(0, MAX_HTML_CHARS)) };
  } catch {
    return { status: null, lang: null, sections: [], jsonLdEvents: [] };
  }
}

export function pageText(sections: Section[]): string {
  return sections.map((s) => (s.heading ? `## ${s.heading}\n${s.text}` : s.text)).join("\n\n").slice(0, MAX_TEXT_CHARS);
}

// The inverse of `pageText`: section texts never hold a blank line, since
// `toText` drops empty lines.
export function parseSections(text: string | null): Section[] {
  if (!text) return [];
  return text.split("\n\n").map((chunk) => {
    if (!chunk.startsWith("## ")) return { heading: null, text: chunk };
    const newline = chunk.indexOf("\n");
    return newline < 0
      ? { heading: chunk.slice(3), text: "" }
      : { heading: chunk.slice(3, newline), text: chunk.slice(newline + 1) };
  });
}

const CONTEXT_CHARS = 240;
const SENTENCE_END = /[.!?\n]/;

// The sentence around text[from, to), at most CONTEXT_CHARS long.
export function sentenceAround(text: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && !SENTENCE_END.test(text[start - 1]) && from - start < CONTEXT_CHARS / 2) start--;
  let end = to;
  while (end < text.length && !SENTENCE_END.test(text[end]) && end - to < CONTEXT_CHARS / 2) end++;
  return text.slice(start, Math.min(text.length, end + 1)).replace(/\s+/g, " ").trim();
}
