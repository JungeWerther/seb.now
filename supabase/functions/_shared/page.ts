/// <reference lib="dom" />
import { parseHTML } from "npm:linkedom@0.18.12";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { PAGE } from "./constants.ts";

// A link's page reduced to what a reader would read. The HTML is parsed into a
// DOM (linkedom), Mozilla's Readability (Firefox's reader view) picks the
// article out of the page's chrome, and its text is split into sections at
// <h1>–<h3> headings, or at paragraphs that open with a bold title. A guide
// listing several events usually gives each one its own heading or bold title,
// so each section can be read as one event. When Readability finds no article
// (a listing it doesn't recognise, a very short page), the whole body is read
// with its menus, headers, footers and forms removed.
//
// Structured data comes first, since it needs no reading: schema.org Event
// objects in JSON-LD are kept as they are, and every named thing the JSON-LD
// says the page is about or mentions (a person, organisation, place, event,
// product or work; not its author, publisher or the site itself) is
// `declared`, a name the page states outright.
//
// entity-extract fetches each page once and keeps the text in `link_content`;
// event-extract reads it back from there with `parseSections`.

// Script and style bodies, which some pages carry megabytes of before their
// article; only JSON-LD is read. Their content can't hold their closing tag,
// so this cut is exact even without a parser.
const SCRIPT_OR_STYLE = /<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi;
const JSON_LD_TYPE = /application\/ld\+json/i;

const DEAD_TAGS = "script, style, noscript, svg, template, iframe, canvas, object";
const CHROME_TAGS = "nav, header, footer, aside, form, button, select, dialog";
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "TR", "TD", "TH", "TABLE", "SECTION", "ARTICLE", "MAIN", "BLOCKQUOTE",
  "DD", "DT", "DL", "FIGURE", "FIGCAPTION", "H4", "H5", "H6", "PRE", "ADDRESS", "BR", "HR",
]);
const HEADING_TAGS = new Set(["H1", "H2", "H3"]);
const BOLD_TAGS = new Set(["STRONG", "B"]);
const EVENT_TYPE = /Event$|^Festival$/;

// schema.org types worth an entity, by the kind entity-extract would give them.
// A subtype not listed here is recognised by its name's ending.
const DECLARED_KIND: [RegExp, string][] = [
  [/^Person$/, "person"],
  [/Event$|^Festival$|^Exhibition/, "event"],
  [/^(?:GovernmentOrganization|GovernmentOffice|Courthouse|City|Country|State|AdministrativeArea)$/, "public_body"],
  [/^(?:NGO|NonprofitOrganization|Charity)$/, "nonprofit"],
  [/Organization$|^Corporation$|Business$|^Store$|^Restaurant$|^Museum$|^Library$|^MusicGroup$|^SportsTeam$/, "company"],
  [/^(?:Place|LandmarksOrHistoricalBuildings|TouristAttraction|Park|CivicStructure|Venue|.*Venue)$/, "place"],
  [/^(?:Product|SoftwareApplication|MobileApplication|WebApplication|VideoGame)$/, "product"],
  [/^(?:Book|Movie|TVSeries|MusicAlbum|MusicRecording|VisualArtwork|Painting|Sculpture|Play|Podcast(?:Series)?|CreativeWorkSeries)$/, "work"],
];
// Keys whose objects are who made or hosts the page, not what it is about.
const NOT_ABOUT_KEYS = new Set([
  "author", "creator", "publisher", "copyrightHolder", "provider", "sourceOrganization", "editor",
  "contributor", "funder", "sponsor", "potentialAction", "breadcrumb", "image", "logo", "isPartOf",
  "mainEntityOfPage", "itemListElement", "brand", "seller", "offers", "aggregateRating", "review",
]);

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

export interface DeclaredName {
  name: string;
  type: string;
  kind: string;
}

export interface PageContent {
  status: number | null;
  lang: string | null;
  sections: Section[];
  jsonLdEvents: JsonLdEvent[];
  declared: DeclaredName[];
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function placeName(location: unknown): string | null {
  const first = Array.isArray(location) ? location[0] : location;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string") {
    return (first as { name: string }).name;
  }
  return null;
}

function kindOf(type: string): string | null {
  return DECLARED_KIND.find(([pattern]) => pattern.test(type))?.[1] ?? null;
}

// Every JSON-LD object on the page, keeping track of whether it hangs under a
// key like `author`. In a @graph a publisher is usually a reference
// (`{"@id": "#org"}`) to a top-level node, so those ids are skipped too.
function readJsonLd(blocks: string[]): { events: JsonLdEvent[]; declared: DeclaredName[] } {
  const roots: unknown[] = [];
  for (const block of blocks) {
    try {
      roots.push(JSON.parse(block.trim()));
    } catch {
      // A malformed block is the page's own bug; the rest of the page still counts.
    }
  }
  const notAbout = new Set<string>();
  const collectIds = (node: unknown, under: boolean) => {
    if (Array.isArray(node)) return node.forEach((n) => collectIds(n, under));
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (under && typeof obj["@id"] === "string") notAbout.add(obj["@id"]);
    for (const [key, value] of Object.entries(obj)) collectIds(value, under || NOT_ABOUT_KEYS.has(key));
  };
  roots.forEach((r) => collectIds(r, false));

  const events: JsonLdEvent[] = [];
  const declared = new Map<string, DeclaredName>();
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? decode(v.trim()) : null);
  const visit = (node: unknown, under: boolean) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, under));
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(obj["@type"] ?? []).filter((t): t is string => typeof t === "string");
    const eventType = types.find((t) => EVENT_TYPE.test(t));
    if (eventType && !under) {
      events.push({ type: eventType, name: str(obj.name), startDate: str(obj.startDate), endDate: str(obj.endDate), location: placeName(obj.location) });
    }
    const name = str(obj.name);
    const skipped = under || (typeof obj["@id"] === "string" && notAbout.has(obj["@id"]));
    for (const type of types) {
      const kind = kindOf(type);
      if (kind && name && !skipped && !declared.has(name.toLowerCase())) {
        declared.set(name.toLowerCase(), { name, type, kind });
        break;
      }
    }
    for (const [key, value] of Object.entries(obj)) visit(value, under || NOT_ABOUT_KEYS.has(key));
  };
  roots.forEach((r) => visit(r, false));
  return { events, declared: [...declared.values()].slice(0, PAGE.DECLARED_MAX) };
}

// Decodes the entities a JSON-LD string sometimes carries, through the parser.
function decode(s: string): string {
  if (!s.includes("&")) return s;
  const { document } = parseHTML(`<p>${s.replace(/</g, "&lt;")}</p>`);
  return document.querySelector("p")?.textContent ?? s;
}

// Sections from a DOM subtree: a heading (or a bold-titled paragraph) starts a
// new section, block elements break lines, and runs of whitespace collapse.
function sectionsOf(root: Element): Section[] {
  const sections: Section[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let line = "";
  let total = 0;
  const breakLine = () => {
    const text = clean(line);
    if (text) lines.push(text);
    line = "";
  };
  const flush = () => {
    breakLine();
    let text = lines.join("\n").slice(0, Math.max(0, PAGE.MAX_TEXT_CHARS - total));
    total += text.length;
    if (text || heading) sections.push({ heading, text });
    lines = [];
    text = "";
  };
  const startSection = (title: string) => {
    flush();
    heading = clean(title) || null;
  };
  const boldTitle = (p: Element): Element | null => {
    for (const child of p.childNodes) {
      if (child.nodeType === TEXT_NODE && clean(child.nodeValue ?? "")) return null;
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as Element;
      if (BOLD_TAGS.has(el.tagName)) return el;
      if (el.tagName === "IMG") continue;
      if (el.tagName === "A") return boldTitle(el);
      return null;
    }
    return null;
  };
  const walk = (node: Element) => {
    for (const child of node.childNodes) {
      if (total >= PAGE.MAX_TEXT_CHARS) return;
      if (child.nodeType === TEXT_NODE) {
        line += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as Element;
      if (HEADING_TAGS.has(el.tagName)) {
        startSection(el.textContent ?? "");
        continue;
      }
      if (el.tagName === "P") {
        const bold = boldTitle(el);
        const length = bold ? clean(bold.textContent ?? "").length : 0;
        if (bold && length >= PAGE.ENTRY_TITLE_MIN_CHARS && length <= PAGE.ENTRY_TITLE_MAX_CHARS) {
          startSection(bold.textContent ?? "");
          bold.remove();
        }
      }
      const block = BLOCK_TAGS.has(el.tagName);
      if (block) breakLine();
      walk(el);
      if (block) breakLine();
    }
  };
  walk(root);
  flush();
  return sections;
}

export function readPage(html: string): Omit<PageContent, "status"> {
  const { document } = parseHTML(html);
  const lang = document.documentElement?.getAttribute("lang")?.toLowerCase() || null;
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? "");
  const { events, declared } = readJsonLd(jsonLd);
  for (const el of document.querySelectorAll(DEAD_TAGS)) el.remove();

  let article: { content?: string | null; textContent?: string | null } | null = null;
  try {
    article = new Readability(document, { charThreshold: PAGE.MIN_ARTICLE_CHARS }).parse();
  } catch {
    article = null;
  }
  let root: Element | null = null;
  if (article?.content && (article.textContent ?? "").trim().length >= PAGE.MIN_ARTICLE_CHARS) {
    root = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body;
  } else {
    // Readability has taken the document apart, so the fallback parses it again.
    const fallback = parseHTML(html).document;
    for (const el of fallback.querySelectorAll(`${DEAD_TAGS}, ${CHROME_TAGS}`)) el.remove();
    root = fallback.querySelector("main") ?? fallback.querySelector("article") ?? fallback.body;
  }
  return { lang, sections: root ? sectionsOf(root) : [], jsonLdEvents: events, declared };
}

export async function fetchHtml(url: string): Promise<{ status: number | null; html: string | null }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": PAGE.USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE.FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      await res.body?.cancel();
      return { status: res.status, html: null };
    }
    const html = (await res.text()).replace(SCRIPT_OR_STYLE, (whole, _tag, attrs) => (JSON_LD_TYPE.test(attrs) ? whole : ""));
    return { status: res.status, html: html.slice(0, PAGE.MAX_HTML_CHARS) };
  } catch {
    return { status: null, html: null };
  }
}

export async function fetchPage(url: string): Promise<PageContent> {
  const { status, html } = await fetchHtml(url);
  const empty = { status, lang: null, sections: [], jsonLdEvents: [], declared: [] };
  if (html === null) return empty;
  try {
    return { status, ...readPage(html) };
  } catch {
    return empty;
  }
}

export function pageText(sections: Section[]): string {
  return sections.map((s) => (s.heading ? `## ${s.heading}\n${s.text}` : s.text)).join("\n\n").slice(0, PAGE.MAX_TEXT_CHARS);
}

// The inverse of `pageText`: section texts never hold a blank line, since
// `sectionsOf` drops empty lines.
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

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

// A sentence ICU ends after a title or short abbreviation ("Dr.", "St.", "M.")
// goes on into the next one.
const ABBREVIATION_END = /(?:^|[\s(])\p{Lu}\p{Ll}{0,2}\.\s*$/u;

// The sentences of `text` (ICU's sentence rules: "3.5" doesn't end one, a line
// break always does), with their offsets.
export function sentences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let joinNext = false;
  for (const s of sentenceSegmenter.segment(text)) {
    const end = s.index + s.segment.length;
    if (joinNext && out.length) out[out.length - 1].end = end;
    else out.push({ start: s.index, end });
    joinNext = !s.segment.includes("\n") && ABBREVIATION_END.test(s.segment);
  }
  return out;
}

// The sentence around text[from, to), at most CONTEXT_CHARS long.
export function sentenceAround(text: string, from: number, to: number): string {
  const lo = Math.max(0, from - PAGE.CONTEXT_CHARS);
  const window = text.slice(lo, Math.min(text.length, to + PAGE.CONTEXT_CHARS));
  let start = from;
  let end = to;
  for (const s of sentences(window)) {
    if (s.end + lo <= from) continue;
    if (s.start + lo >= to) break;
    start = Math.min(start, s.start + lo);
    end = Math.max(end, s.end + lo);
  }
  start = Math.max(start, from - PAGE.CONTEXT_CHARS / 2);
  end = Math.min(end, to + PAGE.CONTEXT_CHARS / 2);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
