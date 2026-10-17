import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { NameHints, textWords } from "./names.ts";
import { DeclaredName } from "./page.ts";
import { HINTS } from "./constants.ts";

// What names.ts needs from the database to read a text: how often the corpus
// capitalises each of its words mid-sentence (`word_case_rates`, only words
// seen at least MIN_EVIDENCE times there), and the known entity names that
// start with one of its capitalised words (`known_names`).


export async function nameHints(
  db: SupabaseClient,
  texts: string[],
  lang: string | null,
  declared: DeclaredName[] = [],
): Promise<NameHints> {
  const { all, nameStarts } = textWords(texts);
  const words = all.slice(0, HINTS.MAX_LOOKUP_WORDS);
  const firstWords = nameStarts.slice(0, HINTS.MAX_LOOKUP_WORDS);
  const [rates, known] = await Promise.all([
    words.length ? db.rpc("word_case_rates", { page_lang: lang, words }) : { data: {}, error: null },
    firstWords.length ? db.rpc("known_names", { first_words: firstWords }) : { data: [], error: null },
  ]);
  if (rates.error) throw new Error(rates.error.message);
  if (known.error) throw new Error(known.error.message);
  const caseRates = new Map<string, number>();
  for (const [word, [capitalised, total]] of Object.entries((rates.data ?? {}) as Record<string, [number, number]>)) {
    if (total >= HINTS.MIN_EVIDENCE) caseRates.set(word, capitalised / total);
  }
  return { caseRates, known: (known.data ?? []) as string[], declared, lang };
}
