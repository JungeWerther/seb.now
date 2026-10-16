// A minimal iCalendar (RFC 5545) reader for public event calendars such as
// Luma's: unfolds lines, reads each VEVENT's properties and turns its start
// and end into dates and a wall-clock time in one zone. Recurrence rules are
// not expanded; a calendar of one-off events (what Luma publishes) needs none.

export type CalendarEvent = {
  uid: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start: EventTime;
  end: EventTime | null;
  cancelled: boolean;
};

// `instant` is the moment the event starts or ends (midnight in `zone` for an
// all-day date); `date` and `time` are what a clock in `zone` shows then.
export type EventTime = { instant: Date; date: string; time: string | null; allDay: boolean };

type Property = { name: string; params: Record<string, string>; value: string };

// RFC 5545 §3.1: a line starting with a space or tab continues the one before.
export function unfold(ics: string): string[] {
  return ics.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

// RFC 5545 §3.3.11 TEXT escapes.
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function parseProperty(line: string): Property | null {
  // The value starts at the first colon not inside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// The offset of `zone` from UTC at `instant`, in minutes.
function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

// A wall-clock time in `zone` as an instant: guess with the offset at the
// naive UTC reading, then correct once (enough across a DST change).
function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = naive - zoneOffsetMinutes(new Date(naive), zone) * 60000;
  return new Date(naive - zoneOffsetMinutes(new Date(first), zone) * 60000);
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

// DATE (20261016), floating or TZID-local DATE-TIME (20261016T180000) or UTC
// DATE-TIME (…Z), shown in `zone`. A floating time is read in `zone` itself.
export function parseEventTime(prop: Property, zone: string): EventTime | null {
  const m = prop.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (m[4] === undefined || prop.params.VALUE === "DATE") {
    return { instant: fromWallClock(y, mo, d, 0, 0, 0, zone), date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
  }
  const [h, mi, s] = [+m[4], +m[5], +m[6]];
  const sourceZone = m[7] ? "UTC" : prop.params.TZID && isZone(prop.params.TZID) ? prop.params.TZID : zone;
  const instant = sourceZone === "UTC"
    ? new Date(Date.UTC(y, mo - 1, d, h, mi, s))
    : fromWallClock(y, mo, d, h, mi, s, sourceZone);
  if (Number.isNaN(instant.getTime())) return null;
  const shown = new Date(instant.getTime() + zoneOffsetMinutes(instant, zone) * 60000);
  return {
    instant,
    date: `${shown.getUTCFullYear()}-${pad(shown.getUTCMonth() + 1)}-${pad(shown.getUTCDate())}`,
    time: `${pad(shown.getUTCHours())}:${pad(shown.getUTCMinutes())}`,
    allDay: false,
  };
}

function httpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseCalendar(ics: string, zone: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let props: Property[] | null = null;
  let depth = 0; // nested components (VALARM) inside a VEVENT are skipped
  for (const line of unfold(ics)) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) {
      props = [];
      depth = 0;
      continue;
    }
    if (!props) continue;
    if (/^BEGIN:/i.test(line)) depth++;
    else if (/^END:VEVENT$/i.test(line.trim()) && depth === 0) {
      const get = (name: string) => props!.find((p) => p.name === name) ?? null;
      const text = (name: string) => {
        const v = get(name)?.value;
        return v ? unescapeText(v).trim() || null : null;
      };
      const dtstart = get("DTSTART");
      const start = dtstart ? parseEventTime(dtstart, zone) : null;
      const summary = text("SUMMARY")?.replace(/\s+/g, " ");
      if (start && summary) {
        const dtend = get("DTEND");
        events.push({
          uid: get("UID")?.value.trim() || null,
          summary,
          description: text("DESCRIPTION"),
          location: text("LOCATION"),
          url: httpUrl(get("URL")?.value ?? null),
          start,
          end: dtend ? parseEventTime(dtend, zone) : null,
          cancelled: (get("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED",
        });
      }
      props = null;
    } else if (/^END:/i.test(line)) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const prop = parseProperty(line);
      if (prop) props.push(prop);
    }
  }
  return events;
}

// The last day an event runs: an all-day DTEND is exclusive (RFC 5545 §3.6.1),
// a timed one ending at midnight ends the day before.
export function lastDay(event: CalendarEvent): string {
  const end = event.end;
  if (!end || end.instant <= event.start.instant) return event.start.date;
  if (end.allDay || end.time === "00:00") {
    const d = new Date(`${end.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.toISOString().slice(0, 10);
    return day < event.start.date ? event.start.date : day;
  }
  return end.date;
}
