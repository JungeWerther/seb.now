// Content script on seb.now/connect only: takes the token the page posts, if
// it carries the nonce of this extension's own Connect (see connection.ts),
// stores it, forgets the nonce so it can't be used twice, and tells the page.

import { CONFIG } from "./config.ts";
import { acceptHandOver, isPendingConnect, saveConnection } from "./connection.ts";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  void (async () => {
    const stored = await chrome.storage.local.get(CONFIG.NONCE_KEY);
    const pending: unknown = stored[CONFIG.NONCE_KEY];
    const connection = acceptHandOver(
      event.origin,
      event.data,
      isPendingConnect(pending) ? pending : undefined,
      Date.now(),
    );
    if (!connection || !isPendingConnect(pending)) return;
    await chrome.storage.local.remove(CONFIG.NONCE_KEY);
    await saveConnection(connection);
    window.postMessage({ type: "seb-follow-connected", nonce: pending.nonce }, CONFIG.SEB_NOW_ORIGIN);
  })();
});
