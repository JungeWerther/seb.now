// The options page: the intake token, kept in this browser's local storage
// only (never synced), and a check that it works.

import { checkToken, type Outcome, reported } from "./actions.ts";
import { CONFIG } from "./config.ts";
import { byId } from "./dom.ts";

const input = byId("token", HTMLInputElement);
const status = byId("status", HTMLParagraphElement);
const save = byId("save", HTMLButtonElement);

const show = (outcome: Outcome | "busy") => {
  save.disabled = outcome === "busy";
  status.textContent = outcome === "busy" ? "Checking…" : outcome.message;
  status.dataset.state = outcome === "busy" ? "busy" : outcome.ok ? "ok" : "error";
};

const saveToken = reported(show)(async () => {
  const token = input.value.trim();
  if (!token) {
    await chrome.storage.local.remove(CONFIG.TOKEN_KEY);
    return { ok: true, message: "Token removed." };
  }
  const outcome = await checkToken(token);
  if (outcome.ok) await chrome.storage.local.set({ [CONFIG.TOKEN_KEY]: token });
  return outcome.ok ? { ok: true, message: "Saved. The token works." } : outcome;
});

byId("form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void saveToken();
});

void chrome.storage.local.get(CONFIG.TOKEN_KEY).then((stored) => {
  const token = stored[CONFIG.TOKEN_KEY];
  if (typeof token === "string") input.value = token;
});
