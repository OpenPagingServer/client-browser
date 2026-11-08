const status = document.getElementById("status");
const log = document.getElementById("log");
let refreshVersion = 0;

async function refresh() {
  const version = ++refreshVersion;
  const { enabled } = await readDebugPreferences();
  if (version !== refreshVersion) return;
  document.getElementById("debug-disabled").hidden = enabled;
  document.getElementById("debug-content").hidden = !enabled;
  if (!enabled) {
    status.textContent = "";
    log.textContent = "";
    return;
  }
  const { debugLog = [], debugDropped = 0 } = await chrome.storage.session.get(["debugLog", "debugDropped"]);
  status.textContent = debugDropped
    ? `${debugDropped} older entries were removed to limit session storage.`
    : "";
  const hosts = await readDebugServerRedaction();
  if (version !== refreshVersion) return;
  log.textContent = debugLog.length ? redactDebugServer(debugLog.join("\n"), hosts) : "Waiting for activity…";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" || (area === "local" && changes.debug) ||
      (area === "session" && (changes.debugLog || changes.lastManagedSettings))) refresh();
});
refresh();
