# seb.now follow

A browser extension that follows the page you're on in seb.now. One build runs
in Chrome and Firefox, desktop and Android.

- **Follow** reads the page's feed links (`<link rel="alternate">`) and identity
  links (`rel="me"`, JSON-LD `sameAs`, author pages), sends them to the
  `follow-intake` Edge Function, which cleans them and stages them in
  `public.follow_inbox`, then opens Claude with `/follow <page>`.
- **Just open in Claude** only opens Claude with `/follow <page>`.

It never sends the page's text, and it reads a page only when you press the
button (`activeTab`): no host permissions, no background script.

## Install

The intake token lives in Supabase Vault as `follow-intake-token`; paste it in
the extension's options ("Save and check" tells you whether it works).

**Chrome (desktop).** Download `seb-follow-extension` from the latest CI run's
artifacts, unzip it, open `chrome://extensions`, turn on Developer mode, then
"Load unpacked" and pick the folder.

**Firefox (desktop and Android).** Firefox only installs signed extensions. CI
signs an unlisted build on every push to `main` once the `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` repository secrets hold an addons.mozilla.org API key
(addons.mozilla.org → Developer Hub → Manage API keys), and uploads it as the
`seb-follow-firefox` artifact. Unlisted means signed by Mozilla, not listed in
their store.

- Desktop: open the `.xpi` file in Firefox.
- Android (10 or later): Settings → About Firefox, tap the Firefox logo five
  times to turn on the debug menu, go back to Settings, choose "Install
  extension from file" and pick the `.xpi`. The button then sits under the
  menu's Extensions entry.

## Develop

```
npm ci
npm run build       # dist/, the unpacked extension
npm run lint        # ESLint, then Firefox's web-ext lint on dist/
npm test            # the extractor on fixtures, the actions with a fake fetch
npm run e2e         # the built popup in Chromium against a local page
```

`src/extract.ts` runs inside the page through `scripting.executeScript`, which
sends the function's source alone, so it imports nothing and takes its limits
as an argument; a test runs the bundled function in an empty context to keep it
that way. Settings live in `src/config.ts`.
