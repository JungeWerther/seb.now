// The options page: this browser's connection to a seb.now account. Connect
// opens seb.now/connect; Disconnect forgets the token here (seb.now/connect,
// opened from Manage devices, revokes it everywhere).

import { CONFIG } from "./config.ts";
import { forgetConnection, loadConnection, startConnect } from "./connection.ts";
import { byId } from "./dom.ts";

const state = byId("state", HTMLParagraphElement);
const connectButton = byId("connect", HTMLButtonElement);
const disconnectButton = byId("disconnect", HTMLButtonElement);

async function render() {
  const connection = await loadConnection();
  state.textContent = !connection
    ? "Not connected."
    : connection.status === "pending"
    ? `Connected, waiting for approval. Code: ${connection.pairCode ?? "?"}`
    : "Connected.";
  state.dataset.state = connection?.status === "active" ? "ok" : connection ? "busy" : "error";
  connectButton.textContent = connection ? "Connect again" : "Connect seb.now";
  disconnectButton.hidden = !connection;
}

connectButton.addEventListener("click", () => void startConnect());
disconnectButton.addEventListener("click", () => void forgetConnection().then(render));
byId("manage", HTMLAnchorElement).href = `${CONFIG.SEB_NOW_ORIGIN}${CONFIG.CONNECT_PATH}`;
chrome.storage.onChanged.addListener((changes) => {
  if (CONFIG.CONNECTION_KEY in changes) void render();
});
void render();
