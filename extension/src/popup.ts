// The popup: Follow sends the page's signals to the inbox and opens Claude
// with /follow; Open in Claude only opens it. Works the same in Chrome and
// Firefox (desktop and Android), which both answer `chrome.*` with promises.

import { claudeUrl, isWebPage, type Outcome, reported, sendSignals } from "./actions.ts";
import { CONFIG } from "./config.ts";
import { byId } from "./dom.ts";
import { extractSignals, type Signals } from "./extract.ts";

const status = byId("status", HTMLParagraphElement);
const buttons = [byId("follow", HTMLButtonElement), byId("open", HTMLButtonElement)];

const show = (outcome: Outcome | "busy") => {
  for (const button of buttons) button.disabled = outcome === "busy";
  status.textContent = outcome === "busy" ? "Working…" : outcome.message;
  status.dataset.state = outcome === "busy" ? "busy" : outcome.ok ? "ok" : "error";
};

// The page the reader is on. On Firefox for Android the popup can open as a
// tab of its own, so the most recently used web tab is taken, not merely the
// active one.
async function targetTab(): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const web = tabs
    .filter((tab) => tab.id !== undefined && isWebPage(tab.url))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastAccessed - a.lastAccessed);
  const tab = web[0];
  if (!tab) throw new Error("Open a web page first.");
  return tab as chrome.tabs.Tab & { id: number; url: string };
}

async function readPage(tabId: number): Promise<Signals> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractSignals,
    args: [CONFIG.LIMITS],
  });
  if (!result?.result) throw new Error("Couldn't read this page.");
  return result.result;
}

async function storedToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(CONFIG.TOKEN_KEY);
  const token = stored[CONFIG.TOKEN_KEY];
  return typeof token === "string" && token ? token : undefined;
}

const openClaude = async (pageUrl: string) => {
  await chrome.tabs.create({ url: claudeUrl(pageUrl) });
  window.close();
};

const follow = reported(show)(async () => {
  const tab = await targetTab();
  const token = await storedToken();
  if (!token) return { ok: false, message: "Add your intake token in the options first, or just open Claude." };
  const outcome = await sendSignals(await readPage(tab.id), token);
  if (outcome.ok) await openClaude(tab.url);
  return outcome;
});

const open = reported(show)(async () => {
  const tab = await targetTab();
  await openClaude(tab.url);
  return { ok: true, message: "Opened Claude." };
});

byId("follow", HTMLButtonElement).addEventListener("click", () => void follow());
byId("open", HTMLButtonElement).addEventListener("click", () => void open());
byId("options", HTMLAnchorElement).addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void (async () => {
  try {
    const tab = await targetTab();
    byId("page", HTMLParagraphElement).textContent = new URL(tab.url).host;
  } catch (error) {
    show({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
})();
