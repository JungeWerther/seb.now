# frontend

TypeScript for the page script in `src/seb_now/templates/index.html`.

Each file in `src/` is a script (no imports or exports). `npm run build`
compiles it with `tsc` into `src/seb_now/templates/`, and `site.py` inlines
the result into the page's single module script, so its declarations are in
scope there and the CSP hash covers it like the rest of the script.

The compiled `.js` is committed, because the DigitalOcean build only runs
Python. CI (`frontend` job) runs ESLint, `tsc --noEmit`, rebuilds and fails
if the committed output differs, then runs the tests in `test/` against the
compiled file.

    npm ci
    npm run lint && npm run typecheck && npm run build && npm test

`test/conventions.test.mjs` holds the code to three rules: no string literal
in a function body (name it at module level, in a constant or a Mapping; the
page script's existing ones are listed in `test/page-strings.json`, which may
only shrink, and `PRUNE_PAGE_STRINGS=1 npm test` drops entries that are gone);
a `Mapping` or `Cases` table is named `<value>By<Key>` after its key type
(`spellingBySenseField: Cases<SenseField, …>`); and no if-chain on a value's
fields where a `Cases` table and `match` would do.

- `src/prelude.ts`: what the others build on. `Result<T>` is the
  `{ data, error }` shape supabase-js answers in, so values and failures
  travel together (`Result.map`/`chain`/`unwrapOr`; a lazy value is
  `Lazy<T>`, `() => Promise<Result<T>>`). `Mapping<K, V>` and `Cases<K, U, R>`
  are tables that replace if-chains, read with `match`.
- `src/filter.ts`: typed filter queries ("event paris") as a monoid of
  filter_links terms plus chips, and the page cache in front of filter_links
  (`memoize`, keyed by the normalized filter and the keyset cursor; it takes
  and returns Results, and keeps no failure). Cache keys are spelled by
  `spellingBySenseField` and joined by `separatorByKeyPart`.
- `src/senses.ts`: what typed words name, for the search box's tags. A
  `lexicon` groups every named thing by its folded words, so a name keeps
  all its senses; `claimNames` reads whole words first, longest names first,
  and lets the word still being typed finish a name only when exactly one
  name could take it; `senseLabel` labels several senses by what they share
  in the kind tree (`commonKindPath`).
