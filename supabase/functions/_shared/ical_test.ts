import { assertEquals } from "jsr:@std/assert@1";
import { lastDay, parseCalendar, unfold, unescapeText } from "./ical.ts";

const ZONE = "Europe/Paris";

// Shaped like Luma's export: LF line ends, folded lines, a quoted CN with a colon.
const LUMA = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:What‘s Happening in Paris",
  "BEGIN:VEVENT",
  "DTSTART:20261016T160000Z",
  "DTEND:20261016T200000Z",
  'ORGANIZER;CN="Climate House: Paris":MAILTO:calendar-invite@lu.ma',
  "UID:evt-cq1DXtEu36IvhQa@events.lu.ma",
  "SUMMARY:Les super pouvoirs de la finance - Réenchanter le futur : pour un",
  "  avenir désirable",
  "DESCRIPTION:Get up-to-date information at: https://luma.com/4xjtnhdd\\n\\nAd",
  " dress:\\nClimate House Paris Sentier\\, Salle Bal-Room",
  "LOCATION:Climate House Paris Sentier, 39 Rue du Caire, 75002 Paris, France",
  "STATUS:TENTATIVE",
  "BEGIN:VALARM",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

Deno.test("folded lines join without the leading space", () => {
  assertEquals(unfold("A:one\r\n two\r\nB:x"), ["A:onetwo", "B:x"]);
});

Deno.test("text escapes are undone", () => {
  assertEquals(unescapeText("a\\, b\\; c\\\\d\\ne"), "a, b; c\\d\ne");
});

Deno.test("a Luma event reads its fields, in Paris time, ignoring the nested alarm", () => {
  const [event] = parseCalendar(LUMA, ZONE);
  assertEquals(event.summary, "Les super pouvoirs de la finance - Réenchanter le futur : pour un avenir désirable");
  assertEquals(event.uid, "evt-cq1DXtEu36IvhQa@events.lu.ma");
  assertEquals(event.description, "Get up-to-date information at: https://luma.com/4xjtnhdd\n\nAddress:\nClimate House Paris Sentier, Salle Bal-Room");
  assertEquals(event.start.date, "2026-10-16");
  assertEquals(event.start.time, "18:00"); // 16:00Z is 18:00 in Paris summer time
  assertEquals(event.start.instant.toISOString(), "2026-10-16T16:00:00.000Z");
  assertEquals(event.end?.time, "22:00");
  assertEquals(event.cancelled, false);
  assertEquals(lastDay(event), "2026-10-16");
});

Deno.test("TZID, floating and all-day times", () => {
  const ics = [
    "BEGIN:VEVENT", "SUMMARY:Local", "DTSTART;TZID=America/New_York:20261220T190000", "END:VEVENT",
    "BEGIN:VEVENT", "SUMMARY:Floating", "DTSTART:20261220T190000", "END:VEVENT",
    "BEGIN:VEVENT", "SUMMARY:Fair", "DTSTART;VALUE=DATE:20261220", "DTEND;VALUE=DATE:20261223", "STATUS:CANCELLED", "END:VEVENT",
  ].join("\r\n");
  const [ny, floating, fair] = parseCalendar(ics, ZONE);
  assertEquals(ny.start.instant.toISOString(), "2026-12-21T00:00:00.000Z");
  assertEquals([ny.start.date, ny.start.time], ["2026-12-21", "01:00"]);
  assertEquals(floating.start.instant.toISOString(), "2026-12-20T18:00:00.000Z"); // winter: UTC+1
  assertEquals(floating.start.time, "19:00");
  assertEquals([fair.start.date, fair.start.time, fair.start.allDay], ["2026-12-20", null, true]);
  assertEquals(lastDay(fair), "2026-12-22"); // an all-day DTEND is exclusive
  assertEquals(fair.cancelled, true);
});

Deno.test("an event without a start or a summary is skipped", () => {
  const ics = "BEGIN:VEVENT\nSUMMARY:No date\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20261016T160000Z\nEND:VEVENT";
  assertEquals(parseCalendar(ics, ZONE), []);
});

Deno.test("a timed event ending at midnight ends the day it started", () => {
  const ics = "BEGIN:VEVENT\nSUMMARY:Night\nDTSTART:20261016T200000\nDTEND:20261017T000000\nEND:VEVENT";
  assertEquals(lastDay(parseCalendar(ics, ZONE)[0]), "2026-10-16");
});
