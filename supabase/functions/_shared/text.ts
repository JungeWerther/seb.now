// Text helpers the ingest functions share.

// `text` cut to at most `max` characters, the last one an ellipsis: at the
// last space before the cut when there is one, or right at it when `atWord`
// is false.
export function truncate(text: string, max: number, { atWord = true }: { atWord?: boolean } = {}): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = atWord ? head.lastIndexOf(" ") : -1;
  return `${space > 0 ? head.slice(0, space) : head}…`;
}

// `html` with every tag replaced by `separator`.
export function stripTags(html: string, separator = ""): string {
  return html.replace(/<[^>]+>/g, separator);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
