async function readDebugPreferences() {
  const [local, cached, policy] = await Promise.all([
    chrome.storage.local.get("debug"),
    chrome.storage.session.get("lastManagedSettings"),
    chrome.storage.managed.get("debug").catch(() => ({}))
  ]);
  const raw = policy.debug ?? cached.lastManagedSettings?.debug;
  const value = raw && typeof raw === "object" ? raw.Value : raw;
  const managed = typeof value === "boolean";
  return { enabled: managed ? value : local.debug === true, managed };
}

async function readDebugServerRedaction() {
  const [local, session, managed] = await Promise.all([
    chrome.storage.local.get(["origin", "serverInput"]),
    chrome.storage.session.get("lastManagedSettings"),
    chrome.storage.managed.get(["hideServerAddress", "serverAddress"]).catch(() => ({}))
  ]);
  const policy = { ...session.lastManagedSettings, ...managed };
  const hidden = policy.hideServerAddress?.Value ?? policy.hideServerAddress;
  if (hidden !== true) return null;

  const hosts = new Set();
  for (const address of [local.origin, local.serverInput, policy.serverAddress?.Value ?? policy.serverAddress]) {
    if (!address) continue;
    try {
      const url = new URL(address.includes("://") ? address : `https://${address}`);
      hosts.add(url.host);
      hosts.add(url.hostname);
    } catch (_) {}
  }
  return [...hosts].sort((a, b) => b.length - a.length);
}

function redactDebugServer(text, hosts) {
  if (!hosts) return text;
  let result = text.replace(/\b((?:https?|wss?):\/\/)[^\s/"'<>]+/gi, "$1[redacted]");
  for (const host of hosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return result;
}
