import { assert, assertEquals } from "jsr:@std/assert@1";
import { aloneSentence, fragments, readSpans, sentenceWith, Span, standsAlone } from "./spans.ts";

const span = (surface: string): Span => ({ surface });
const surfaces = (spans: Span[]) => spans.map((s) => s.surface);
const never = () => Promise.resolve(new Set<Span>());

Deno.test("a name said only inside a longer one is a fragment", () => {
  const text = "Le Palais de Tokyo rouvre ses portes. L'exposition au Palais de Tokyo dure un mois.";
  assert(!standsAlone("Tokyo", ["Palais de Tokyo"], text));
  assertEquals(surfaces(fragments([span("Tokyo"), span("Palais de Tokyo")], [span("Palais de Tokyo")], text)), ["Tokyo"]);
});

Deno.test("a name the text also says on its own stands alone", () => {
  const text = "Après le Palais de Tokyo, elle expose à Tokyo.";
  assert(standsAlone("Tokyo", ["Palais de Tokyo"], text));
  assertEquals(fragments([span("Tokyo")], [span("Palais de Tokyo")], text), []);
});

Deno.test("case, curly apostrophes and possessives don't hide an occurrence", () => {
  assert(!standsAlone("Pentagon", ["The Pentagon"], "the Pentagon’s budget grew; THE PENTAGON said so."));
  assert(standsAlone("Pentagon", ["The Pentagon"], "Pentagon officials met the Pentagon’s auditors."));
});

Deno.test("a name the text doesn't say as written is kept", () => {
  assert(standsAlone("Musée d'Orsay", ["Crypte du Musée d'Orsay"], "Une visite au musee"));
});

Deno.test("a fragment of a name read whole is dropped once the holder is read whole", async () => {
  let asked = 0;
  const reading = await readSpans(
    [span("Palais de Tokyo"), span("Tokyo"), span("Paris")],
    [],
    "Le Palais de Tokyo, à Paris, rouvre.",
    (holders) => {
      asked += holders.length;
      return Promise.resolve(new Set<Span>());
    },
  );
  assertEquals(surfaces(reading.kept), ["Palais de Tokyo", "Paris"]);
  assertEquals(surfaces(reading.parts), ["Tokyo"]);
  assertEquals(asked, 1);
});

Deno.test("a name that runs two names together gives way to its parts", async () => {
  const names = [span("Ledger Flex and Ledger Stax"), span("Ledger Flex"), span("Ledger Stax")];
  const reading = await readSpans(names, [], "The Ledger Flex and Ledger Stax ship today.", (holders) => {
    assertEquals(holders.map((h) => [h.name.surface, surfaces(h.parts)]), [["Ledger Flex and Ledger Stax", ["Ledger Flex", "Ledger Stax"]]]);
    return Promise.resolve(new Set([names[0]]));
  });
  assertEquals(surfaces(reading.kept), ["Ledger Flex", "Ledger Stax"]);
  assertEquals(surfaces(reading.runTogether), ["Ledger Flex and Ledger Stax"]);
  assertEquals(reading.parts, []);
});

Deno.test("a name read whole in the title makes a page fragment of its parts", async () => {
  const reading = await readSpans([span("Tokyo")], [span("Palais de Tokyo")], "Palais de Tokyo: the new show. The Palais de Tokyo opens.", never);
  assertEquals(reading.kept, []);
  assertEquals(surfaces(reading.parts), ["Tokyo"]);
});

Deno.test("nested fragments fall with the name that holds them", async () => {
  const names = [span("President Donald Trump"), span("Donald Trump"), span("Trump")];
  const text = "President Donald Trump spoke. Later, Trump left.";
  const kept = await readSpans(names, [], text, () => Promise.resolve(new Set([names[0]])));
  // Read as a title plus a name, "Donald Trump" and the lone "Trump" stay.
  assertEquals(surfaces(kept.kept), ["Donald Trump", "Trump"]);
  const whole = await readSpans(names, [], text, never);
  assertEquals(surfaces(whole.kept), ["President Donald Trump", "Trump"]);
  assertEquals(surfaces(whole.parts), ["Donald Trump"]);
});

Deno.test("no fragment means no question", async () => {
  const reading = await readSpans([span("Paris"), span("Lyon")], [], "Paris et Lyon.", () => {
    throw new Error("asked");
  });
  assertEquals(surfaces(reading.kept), ["Paris", "Lyon"]);
});

Deno.test("the sentence that says a name", () => {
  assertEquals(sentenceWith("Il pleut. Le Palais de Tokyo ouvre. Fin.", "palais de tokyo", "fr"), "Le Palais de Tokyo ouvre.");
  assertEquals(sentenceWith("Il pleut.", "Tokyo"), null);
});

Deno.test("a name is never matched across a sentence end", () => {
  assert(standsAlone("New York", ["New York Times"], "The New York Times reported from New York. Times are hard."));
  assert(!standsAlone("New York", ["New York Times"], "The New York Times reported.\nThe New York Times again."));
});

Deno.test("an invalid page language falls back to the default locale", () => {
  assertEquals(sentenceWith("Il pleut. Tokyo dort.", "Tokyo", "en_US"), "Tokyo dort.");
});

Deno.test("initials and short abbreviations don't end a sentence", () => {
  assert(!standsAlone("Thi Nguyen", ["C. Thi Nguyen"], "C. Thi Nguyen spoke."));
  assert(!standsAlone("Smith", ["Dr. Smith"], "We met Dr. Smith today."));
  assert(standsAlone("New York", ["New York Times"], "He lives in New York. Times change."));
});

Deno.test("the sentence offered is the one where the name stands alone", () => {
  const body = "The Palais de Tokyo opens tomorrow. She then flew to Tokyo.";
  assertEquals(aloneSentence(body, "Tokyo", ["Palais de Tokyo"]), "She then flew to Tokyo.");
  assertEquals(aloneSentence("The Palais de Tokyo opens.", "Tokyo", ["Palais de Tokyo"]), null);
});
