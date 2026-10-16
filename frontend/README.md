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

- `src/filter.ts`: typed filter queries ("event paris") as a monoid of
  filter_links terms plus chips, and the page cache in front of filter_links
  (`memoizePages`, keyed by the normalized filter and the keyset cursor).
