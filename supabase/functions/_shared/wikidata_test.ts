import { assertEquals } from "jsr:@std/assert@1";
import { bestClaim, readItem, wikidata } from "./wikidata.ts";
import { limited } from "./limit.ts";
import { WIKIDATA } from "./constants.ts";

const ref = (id: string, extra: Record<string, unknown> = {}) => ({ mainsnak: { datavalue: { value: { id } } }, rank: "normal", ...extra });
const ENTITIES: Record<string, Record<string, unknown>> = {
  Q1: {
    id: "Q1", labels: { en: { value: "Palais de Tokyo" } }, descriptions: { fr: { value: "musée à Paris" } },
    claims: { P131: [ref("Q2")], P17: [ref("Q3")], P625: [{ mainsnak: { datavalue: { value: {} } } }] },
  },
  Q2: { id: "Q2", labels: { en: { value: "16th arrondissement of Paris" } }, claims: { P17: [ref("Q3")] } },
  Q3: { id: "Q3", labels: { en: { value: "France" } }, claims: { P297: [{ mainsnak: { datavalue: { value: "FR" } } }] } },
  Q4: { id: "Q4", labels: { en: { value: "Tokyo (band)" } }, claims: {} },
};

function fakeFetch() {
  const urls: string[] = [];
  const fetchJson = (url: string) => {
    urls.push(url);
    const params = new URL(url).searchParams;
    if (params.get("action") === "wbsearchentities") {
      return Promise.resolve({ search: params.get("search") === "Tokyo" ? [{ id: "Q4" }, { id: "Q1" }] : [] });
    }
    const ids = params.get("ids")!.split("|");
    return Promise.resolve({ entities: Object.fromEntries(ids.map((id) => [id, ENTITIES[id] ?? { id, missing: "" }])) });
  };
  return { urls, fetchJson };
}

Deno.test("the current, best-ranked claim is read", () => {
  const entity = { claims: { P131: [ref("Q9", { rank: "deprecated" }), ref("Q8", { qualifiers: { P582: [] } }), ref("Q7"), ref("Q6", { rank: "preferred" })] } };
  assertEquals((bestClaim(entity, "P131") as { id: string }).id, "Q6");
  assertEquals(bestClaim(entity, "P17"), null);
});

Deno.test("an item is placed in its area, an area in its country, a country nowhere", () => {
  assertEquals(readItem(ENTITIES.Q1, ["en", "fr"]), {
    id: "Q1", label: "Palais de Tokyo", description: "musée à Paris", parent: "Q2", country: "Q3", iso: null, located: true,
  });
  assertEquals(readItem(ENTITIES.Q2, ["en"]).parent, "Q3");
  assertEquals(readItem(ENTITIES.Q3, ["en"]), { id: "Q3", label: "France", description: null, parent: null, country: "Q3", iso: "FR", located: true });
});

Deno.test("search keeps located items, and items are fetched once", async () => {
  const { urls, fetchJson } = fakeFetch();
  const wd = wikidata(fetchJson, ["en", "fr"]);
  const hits = await wd.search("Tokyo");
  assertEquals(hits.map((h) => h.id), ["Q1"]);
  assertEquals(await wd.describe(hits[0]), "Palais de Tokyo: musée à Paris (in 16th arrondissement of Paris, France)");
  assertEquals(await wd.isoOf(hits[0]), "FR");
  const before = urls.length;
  await wd.item("Q1");
  await wd.item("Q3");
  assertEquals(urls.length, before);
});

Deno.test("an API error in a 200 body fails instead of finding nothing", async () => {
  const wd = wikidata(() => Promise.resolve({ error: { code: "maxlag" } }), ["en"]);
  let failed = false;
  await wd.search("Paris").catch(() => failed = true);
  assertEquals(failed, true);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

Deno.test("a gate lets `size` calls run at once across the functions it wraps, in order", async () => {
  const gate = limited(2);
  let running = 0, most = 0;
  const order: string[] = [];
  const work = (name: string) => async (fail = false) => {
    running++;
    most = Math.max(most, running);
    order.push(name);
    await tick();
    running--;
    if (fail) throw new Error(name);
    return name;
  };
  const [a, b] = [gate(work("a")), gate(work("b"))];
  const results = await Promise.allSettled([a(), b(true), a(), b(), a(true), b()]);
  assertEquals(most, 2);
  assertEquals(order, ["a", "b", "a", "b", "a", "b"]);
  assertEquals(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
  // A rejected call gave its slot back: the gate still runs two at once.
  most = 0;
  await Promise.all([a(), b(), a()]);
  assertEquals(most, 2);
});

Deno.test("every Wikidata request a reader makes shares one limit, searches and descriptions alike", async () => {
  const { fetchJson } = fakeFetch();
  let running = 0, most = 0;
  const slow = async (url: string) => {
    running++;
    most = Math.max(most, running);
    await tick();
    running--;
    return fetchJson(url);
  };
  // Two readers, as two overlapping runs in one isolate would have.
  const [one, two] = [wikidata(slow, ["en", "fr"]), wikidata(slow, ["en", "fr"])];
  const [hits] = await Promise.all([one.search("Tokyo"), two.search("Tokyo"), two.search("Paris")]);
  await Promise.all(hits.map((h) => one.describe(h)));
  assertEquals(most, WIKIDATA.MAX_CONCURRENT_REQUESTS);
});
