import { assert, assertEquals } from "jsr:@std/assert@1";
import { fold, knownNamesIn, pageCandidates, textWords } from "./names.ts";

const RATES = new Map([
  ["des", 0], ["pour", 0], ["apres", 0], ["the", 0.02], ["after", 0.04], ["new", 0.15], ["york", 1], ["le", 0.01],
  ["musee", 0.4], ["galerie", 0.5], ["octobre", 0], ["meet", 0.04], ["your", 0.02], ["paris", 0.99], ["apple", 0.98],
  ["agent", 0.07], ["infos", 0], ["party", 0.17],
]);
const surfaces = (text: string, hints = {}) =>
  pageCandidates([{ heading: null, text }], "", { caseRates: RATES, lang: "fr", ...hints }).map((p) => p.surface);

Deno.test("a common word opening a sentence is dropped from the run", () => {
  assertEquals(surfaces("Pour Claude Monet, la lumière compte. Il aime Claude Monet."), ["Claude Monet"]);
  assertEquals(surfaces("Après Paris, Londres."), ["Paris", "Londres"]);
});

Deno.test("a word that is a name wherever it stands is kept at a sentence start", () => {
  assertEquals(surfaces("Apple a présenté un téléphone."), ["Apple"]);
  assert(surfaces("New York est grande.").includes("New York"));
});

Deno.test("title-case lines keep their first word", () => {
  assert(surfaces("Meet Your Seoul").includes("Meet Your Seoul"));
});

Deno.test("names join across particles, split at conjunctions and take a name-opening word in front", () => {
  const found = surfaces("On visite la galerie Perrotin et le Théâtre du Châtelet, puis le musée d'Orsay.");
  for (const name of ["Perrotin", "Théâtre du Châtelet", "galerie Perrotin", "musée d'Orsay", "Orsay"]) assert(found.includes(name), name);
  assert(!found.includes("le Théâtre du Châtelet"));
});

Deno.test("months and weekdays are not names", () => {
  assertEquals(surfaces("On y va en Octobre, le Samedi."), []);
});

Deno.test("known names are found where capitalisation alone would miss them", () => {
  const found = surfaces("Agent Smith arrive. Infos: Le Grand Palais ouvre.", { known: ["Grand Palais", "Agent"] });
  assert(found.includes("Grand Palais"));
  assert(!found.includes("Agent"), "a mostly-common one-word name opening a sentence");
});

Deno.test("declared names come first", () => {
  const found = surfaces("Rien ici sur Paris.", { declared: [{ name: "Expo Monet", type: "ExhibitionEvent", kind: "event" }] });
  assertEquals(found[0], "Expo Monet");
});

Deno.test("knownNamesIn finds known names in a title-case headline", () => {
  const hints = { caseRates: RATES, known: ["New York Times", "Party", "Apple"] };
  assertEquals(knownNamesIn("The New York Times Party For Apple Fans", hints).sort(), ["Apple", "New York Times"]);
});

Deno.test("fold and textWords match the SQL folding", () => {
  assertEquals(fold("Dès L’Œuvre"), "des l'oeuvre");
  assertEquals(textWords(["le musée d'Orsay ouvre"]).nameStarts.sort(), ["musee", "orsay"]);
});

Deno.test("a known name inside a longer run isn't offered alone", () => {
  const found = surfaces("Il dîne avec Mylo Levin et chez Levin seul.", { known: ["Levin"] });
  assert(found.includes("Mylo Levin"));
  assertEquals(found.filter((f) => f === "Levin").length, 1, "only where it stands alone");
});

Deno.test("numbers, initials, camel case and a capital elided article stay in names", () => {
  const found = surfaces("Il a présenté la Li 6 sous Windows 11 avec C. Thi Nguyen, testé xAI et dîné chez L'Assaggio.");
  for (const name of ["Li 6", "Windows 11", "Windows", "C. Thi Nguyen", "xAI", "L'Assaggio"]) assert(found.includes(name), name);
});

Deno.test("short month names are not names", () => {
  assertEquals(surfaces("Il part le 3 Oct pour revenir en Nov."), []);
});
