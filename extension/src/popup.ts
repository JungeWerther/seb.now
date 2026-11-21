// The popup: Follow sends the page's signals to the inbox and opens Claude
// with /follow; Open in Claude only opens it; Connect links this browser to a
// seb.now account first. Works the same in Chrome and Firefox (desktop and
// Android), which both answer `chrome.*` with promises.

import { claudeUrl, isWebPage, type Outcome, reported, sendSignals } from "./actions.ts";
import { CONFIG } from "./config.ts";
import {
  type Connection,
  forgetConnection,
  loadConnection,
  requestSebNowAccess,
  saveConnection,
  startConnect,
} from "./connection.ts";
import { byId } from "./dom.ts";
import { extractSignals, type Signals } from "./extract.ts";

const status = byId("status", HTMLParagraphElement);
const followButton = byId("follow", HTMLButtonElement);
const buttons = [followButton, byId("open", HTMLButtonElement)];

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

// What the intake's answer says about this device's connection, kept.
const settle = (connection: Connection, outcome: Outcome) => {
  const effects = {
    gone: () => forgetConnection(),
    pending: () => saveConnection({ ...connection, status: "pending", pairCode: outcome.pairCode ?? connection.pairCode }),
    active: () => saveConnection({ ...connection, status: "active", pairCode: null }),
  };
  return outcome.connection ? effects[outcome.connection]() : Promise.resolve();
};

const openClaude = async (pageUrl: string) => {
  await chrome.tabs.create({ url: claudeUrl(pageUrl) });
  window.close();
};

// `access` is asked for at the click itself (see requestSebNowAccess) and
// only waited on when there is no connection yet.
const follow = reported(show)(async (access: Promise<boolean>) => {
  const connection = await loadConnection();
  if (!connection) {
    await startConnect(access);
    window.close();
    return { ok: true, message: "Opening seb.now to connect…" };
  }
  const tab = await targetTab();
  const outcome = await sendSignals(await readPage(tab.id), connection.token);
  await settle(connection, outcome);
  if (outcome.ok) await openClaude(tab.url);
  else await render();
  return outcome;
});

const open = reported(show)(async () => {
  const tab = await targetTab();
  await openClaude(tab.url);
  return { ok: true, message: "Opened Claude." };
});

// The Follow button says what it will do: connect first, or follow.
async function render() {
  const connection = await loadConnection();
  followButton.textContent = connection ? "Follow" : "Connect seb.now";
  byId("connection", HTMLParagraphElement).textContent = !connection
    ? "Not connected yet."
    : connection.status === "pending"
    ? `Waiting for approval, code ${connection.pairCode ?? "?"}.`
    : "Connected.";
}

followButton.addEventListener("click", () => {
  const access = requestSebNowAccess();
  void follow(access);
});
byId("open", HTMLButtonElement).addEventListener("click", () => void open());
byId("options", HTMLAnchorElement).addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void (async () => {
  await render();
  try {
    const tab = await targetTab();
    byId("page", HTMLParagraphElement).textContent = new URL(tab.url).host;
  } catch (error) {
    show({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
})();
