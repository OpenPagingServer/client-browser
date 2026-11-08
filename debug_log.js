const DEBUG_LOG_LIMIT = 1000;
let debugWrites = Promise.resolve();
let debugPolicy = readDebugPreferences().then(settings => settings.enabled).catch(() => false);

chrome.storage.onChanged.addListener((changes, area) => {
  const debugChanged = (area === "managed" || area === "local") && changes.debug;
  const cachedPolicyChanged = area === "session" &&
    changes.lastManagedSettings?.oldValue?.debug !== changes.lastManagedSettings?.newValue?.debug;
  if (!debugChanged && !cachedPolicyChanged) return;
  const previous = debugPolicy;
  debugPolicy = readDebugPreferences().then(settings => settings.enabled).catch(() => false);
  const current = debugPolicy;
  Promise.all([previous, current]).then(([wasEnabled, enabled]) => {
    if (current !== debugPolicy) return;
    if (enabled && !wasEnabled) debugEvent("Debug logging enabled");
    if (!enabled) {
      debugWrites = debugWrites.catch(() => {}).then(() => chrome.storage.session.remove(["debugLog", "debugDropped", "debugServerRedacted"]));
    }
  });
});

function debugRedact(value) {
  return JSON.stringify(value, (key, field) => {
    if (/token|secret|credential|password|challenge|authorization|cookie|email|private.?key|request.?id|username/i.test(key)) {
      return "[redacted]";
    }
    if (typeof field !== "string") return field;
    return field.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/([?&](?:token|code|key|signature|state)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted email]");
  });
}

function debugEvent(event, details = {}) {
  const time = new Date().toISOString();
  debugWrites = debugWrites.catch(() => {}).then(async () => {
    if (!await debugPolicy) return;
    const { debugLog = [], debugDropped = 0, debugServerRedacted = false } = await chrome.storage.session.get(["debugLog", "debugDropped", "debugServerRedacted"]);
    const hosts = await readDebugServerRedaction();
    const text = redactDebugServer(debugRedact(details), hosts);
    if (hosts && !debugServerRedacted) {
      for (let i = 0; i < debugLog.length; i++) debugLog[i] = redactDebugServer(debugLog[i], hosts);
    }
    debugLog.push(`${time} ${event} ${text.length > 2400 ? text.slice(0, 2400) + "… [truncated]" : text}`);
    const dropped = Math.max(0, debugLog.length - DEBUG_LOG_LIMIT);
    if (dropped) debugLog.splice(0, dropped);
    await chrome.storage.session.set({ debugLog, debugDropped: debugDropped + dropped, debugServerRedacted: Boolean(hosts) });
  }).catch(() => {});
}

function debugUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) {
    return "[invalid URL]";
  }
}

async function debugFetch(url, options = {}) {
  const enabled = await debugPolicy;
  if (!enabled) return fetch(url, options);
  const target = debugUrl(url);
  const method = options.method || "GET";
  const started = Date.now();
  let requestBody;
  try { if (options.body) requestBody = JSON.parse(options.body); } catch (_) {}
  debugEvent("HTTP request", { method, url: target, redirect: options.redirect, body: requestBody });
  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get("content-type");
    const details = {
      method, url: target, responseUrl: debugUrl(response.url), status: response.status,
      statusText: response.statusText, redirected: response.redirected, contentType, elapsedMs: Date.now() - started
    };
    if (contentType?.includes("json")) {
      response.clone().json().then(body => debugEvent("HTTP response", { ...details, body }))
        .catch(() => debugEvent("HTTP response", details));
    } else {
      debugEvent("HTTP response", details);
    }
    return response;
  } catch (error) {
    debugEvent("HTTP failure", { method, url: target, name: error.name, message: error.message, elapsedMs: Date.now() - started });
    throw error;
  }
}
