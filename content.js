(async function captureOpenPagingSession() {
  async function waitForConfiguredOrigin() {
    const current = await chrome.storage.local.get(["origin"]);
    if (current.origin) return current.origin;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.storage.onChanged.removeListener(listener);
        resolve("");
      }, 15000);
      function listener(changes, areaName) {
        if (areaName !== "local" || !changes.origin?.newValue) return;
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(listener);
        resolve(changes.origin.newValue);
      }
      chrome.storage.onChanged.addListener(listener);
    });
  }

  const origin = await waitForConfiguredOrigin();
  if (!origin || location.origin !== origin) return;

  let extensionDisabled = false;
  function syncReceiverState() {
    window.postMessage({
      source: "ops-extension-content",
      type: "SET_RECEIVER_ENABLED",
      enabled: !extensionDisabled
    }, location.origin);
  }
  async function refreshDisabledState() {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
    extensionDisabled = state?.extensionDisabled === true;
    syncReceiverState();
  }
  await refreshDisabledState();
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === "local" || areaName === "managed") refreshDisabledState();
  });

  await chrome.runtime.sendMessage({ type: "ENABLE_PAGE_BRIDGE" }).catch(() => {});
  syncReceiverState();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "ops-browser-extension") return;
    if (event.data.type === "OPEN_EXTENSION_POPUP") chrome.runtime.sendMessage({ type: "OPEN_EXTENSION_POPUP" }).catch(() => {});
    if (event.data.type === "WEB_SESSION" && !extensionDisabled && event.data.session?.token) {
      chrome.runtime.sendMessage({ type: "WEB_SESSION", session: event.data.session }).catch(() => {});
    }
    if (event.data.type === "WEB_LOGOUT" && !extensionDisabled) {
      chrome.runtime.sendMessage({ type: "WEB_LOGOUT" }).catch(() => {});
    }
  });
})();
