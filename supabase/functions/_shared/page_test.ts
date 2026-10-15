import { assertEquals } from "jsr:@std/assert@1";
import { pageText, parseSections, readPage, sentenceAround } from "./page.ts";

const ARTICLE = "<p>" + "Une longue phrase sur l'exposition qui dure tout l'automne au musée. ".repeat(12) + "</p>";

Deno.test("readPage keeps the article and drops the chrome", () => {
  const page = readPage(`<html lang="fr-FR"><body>
    <header><nav><a>Accueil</a><a>Agenda</a></nav></header>
    <article><h1>Le titre</h1>${ARTICLE}
      <p><strong>Meet Your Seoul au Palais de Tokyo</strong><br>Du 6 au 27 octobre, une exposition coréenne.</p>
      <h2>Infos pratiques</h2><p>Ouvert tous les jours sauf le mardi.</p>
    </article>
    <footer>Mentions légales</footer><script>var x = "Accueil";</script></body></html>`);
  assertEquals(page.lang, "fr-fr");
  const text = pageText(page.sections);
  assertEquals(text.includes("Accueil") || text.includes("Mentions légales"), false);
  assertEquals(page.sections.map((s) => s.heading).filter(Boolean), [
    "Le titre",
    "Meet Your Seoul au Palais de Tokyo",
    "Infos pratiques",
  ]);
  assertEquals(page.sections[1].text, "Du 6 au 27 octobre, une exposition coréenne.");
});

Deno.test("readPage falls back to the body when there is no article", () => {
  const page = readPage(`<html><body><nav>Menu</nav><main><p>Short page about Grand Palais.</p></main></body></html>`);
  assertEquals(pageText(page.sections), "Short page about Grand Palais.");
});

Deno.test("JSON-LD events are kept and declared names skip the author and publisher", () => {
  const page = readPage(`<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "NewsArticle",
        author: { "@type": "Person", name: "Jean Auteur" },
        publisher: { "@id": "#org" },
        about: { "@type": "Museum", name: "Musée d&#039;Orsay" },
      },
      { "@id": "#org", "@type": "Organization", name: "Sortir à Paris" },
      { "@type": "ExhibitionEvent", name: "Expo Monet", startDate: "2026-10-01", location: { "@type": "Place", name: "Grand Palais" } },
    ],
  })}</script></head><body><p>x</p></body></html>`);
  assertEquals(page.jsonLdEvents, [{ type: "ExhibitionEvent", name: "Expo Monet", startDate: "2026-10-01", endDate: null, location: "Grand Palais" }]);
  assertEquals(page.declared.map((d) => [d.name, d.kind]), [["Musée d'Orsay", "company"], ["Expo Monet", "event"], ["Grand Palais", "place"]]);
});

Deno.test("parseSections inverts pageText", () => {
  const sections = [{ heading: null, text: "Intro line\nSecond line" }, { heading: "A heading", text: "Body" }, { heading: "Empty", text: "" }];
  assertEquals(parseSections(pageText(sections)), sections);
});

Deno.test("sentenceAround takes the whole sentence, abbreviations included", () => {
  const text = "First one. Dr. Smith met Apple in Paris. Last one.";
  const at = text.indexOf("Apple");
  assertEquals(sentenceAround(text, at, at + 5), "Dr. Smith met Apple in Paris.");
});
