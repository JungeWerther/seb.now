// What a page says about where to follow it, read inside the page.
//
// `extractSignals` is injected with scripting.executeScript({func}), which
// sends the function's source alone, so it must be self-contained: no imports,
// no module-level names, its limits passed in as an argument. Everything it
// returns is a candidate, capped in size but not trusted; the follow-intake
// function cleans it (https only, public hosts, no hidden characters).
//
// It reads metadata and links only, never the page's text: a signed-in page
// can hold private mail.

export interface Limits {
  // Items kept per list.
  maxItems: number;
  // Characters kept per string.
  maxString: number;
  // JSON-LD scripts read, and characters read from each.
  maxJsonLdScripts: number;
  maxJsonLdChars: number;
}

export interface Feed {
  url: string;
  title?: string;
}

export interface Signals {
  url: string;
  canonical?: string;
  title?: string;
  site_name?: string;
  description?: string;
  author?: string;
  feeds: Feed[];
  rel_me: string[];
  same_as: string[];
  author_urls: string[];
}

export function extractSignals(limits: Limits, doc: Document = document, href: string = location.href): Signals {
  const cut = (value: string | null | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, limits.maxString) : undefined;
  };

  const baseAttr = doc.querySelector("base[href]")?.getAttribute("href");
  const base = (() => {
    try {
      return new URL(baseAttr ?? href, href).href;
    } catch {
      return href;
    }
  })();

  // An attribute or JSON-LD value read as an absolute URL against the page.
  const absolute = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const raw = value.trim();
    if (!raw) return undefined;
    try {
      return cut(new URL(raw, base).href);
    } catch {
      return undefined;
    }
  };

  const unique = <T>(items: (T | undefined)[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    const kept: T[] = [];
    for (const item of items) {
      if (item === undefined || seen.has(key(item))) continue;
      seen.add(key(item));
      kept.push(item);
      if (kept.length === limits.maxItems) break;
    }
    return kept;
  };
  const urls = (items: (string | undefined)[]) => unique(items, (u) => u);

  const meta = (selector: string) => cut(doc.querySelector(selector)?.getAttribute("content"));
  const hrefs = (selector: string) =>
    Array.from(doc.querySelectorAll(selector)).map((el) => absolute(el.getAttribute("href")));

  // JSON-LD: every node, through @graph and arrays, of the first scripts.
  const nodes: Record<string, unknown>[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || nodes.length > 200 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    nodes.push(node);
    for (const key of ["@graph", "mainEntity", "author", "creator", "publisher", "about"]) {
      if (key in node) walk(node[key], depth + 1);
    }
  };
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(
    0,
    limits.maxJsonLdScripts,
  );
  for (const script of scripts) {
    const source = script.textContent;
    if (source.length > limits.maxJsonLdChars) continue;
    try {
      walk(JSON.parse(source), 0);
    } catch {
      // A page's broken JSON-LD is its own business.
    }
  }

  const typesOf = (node: Record<string, unknown>): string[] =>
    ([] as unknown[]).concat(node["@type"] ?? []).filter((t): t is string => typeof t === "string");
  const isWho = (node: Record<string, unknown>) =>
    typesOf(node).some((t) => ["Person", "Organization", "NewsMediaOrganization", "Corporation"].includes(t));
  const listOf = (value: unknown): unknown[] => ([] as unknown[]).concat(value ?? []);

  const who = nodes.filter(isWho);
  const sameAs = who.flatMap((node) => listOf(node.sameAs).map(absolute));
  const jsonLdAuthors = nodes.flatMap((node) => listOf(node.author)).filter(
    (a): a is Record<string, unknown> => typeof a === "object" && a !== null,
  );
  const authorName = jsonLdAuthors.map((a) => (typeof a.name === "string" ? cut(a.name) : undefined)).find(Boolean);

  const feedTypes = ["application/rss+xml", "application/atom+xml", "application/feed+json", "application/json"];
  const feeds = unique(
    Array.from(doc.querySelectorAll("link[rel~='alternate'][href]"))
      .filter((link) => feedTypes.includes((link.getAttribute("type") ?? "").toLowerCase().trim()))
      .map((link): Feed | undefined => {
        const url = absolute(link.getAttribute("href"));
        if (!url) return undefined;
        const title = cut(link.getAttribute("title"));
        return title ? { url, title } : { url };
      }),
    (feed) => feed.url,
  );

  const signals: Signals = {
    url: cut(href) ?? href,
    feeds,
    rel_me: urls([...hrefs("link[rel~='me'][href]"), ...hrefs("a[rel~='me'][href]")]),
    same_as: urls(sameAs),
    author_urls: urls([
      ...hrefs("link[rel~='author'][href]"),
      ...hrefs("a[rel~='author'][href]"),
      ...jsonLdAuthors.map((a) => absolute(a.url)),
    ]),
  };
  const optional: [keyof Signals, string | undefined][] = [
    ["canonical", absolute(doc.querySelector("link[rel~='canonical']")?.getAttribute("href"))],
    ["title", meta("meta[property='og:title']") ?? cut(doc.title)],
    ["site_name", meta("meta[property='og:site_name']")],
    ["description", meta("meta[name='description']") ?? meta("meta[property='og:description']")],
    ["author", meta("meta[name='author']") ?? authorName],
  ];
  for (const [key, value] of optional) if (value !== undefined) Object.assign(signals, { [key]: value });
  return signals;
}
