(function installOpenPagingExtensionBridge() {
  if (window.__opsBrowserExtensionBridge) return;
  window.__opsBrowserExtensionBridge = true;
  window.__OPS_DESKTOP_CLIENT__ = true;
  window.__OPS_BROWSER_EXTENSION__ = true;
  let receiverEnabled = false;
  let lastToken = "";
  let loggedOutChecks = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "ops-extension-content") return;
    if (event.data.type === "SET_RECEIVER_ENABLED") receiverEnabled = event.data.enabled === true;
  });

  async function pollWebSession() {
    if (!receiverEnabled) return;
    try {
      const response = await fetch("/desktop/session/token?desktop_client=1", {
        method: "POST",
        credentials: "include",
        headers: {
          "x-ops-desktop-client": "1",
          "X-OPS-Client-OS": "Chrome Extension"
        }
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) loggedOutChecks += 1;
        if (loggedOutChecks >= 2) {
          lastToken = "";
          window.postMessage({ source: "ops-browser-extension", type: "WEB_LOGOUT" }, location.origin);
        }
        return;
      }
      const session = await response.json();
      if (!session?.token) {
        loggedOutChecks += 1;
        if (loggedOutChecks >= 2) window.postMessage({ source: "ops-browser-extension", type: "WEB_LOGOUT" }, location.origin);
        return;
      }
      loggedOutChecks = 0;
      if (session.token === lastToken) return;
      lastToken = session.token;
      window.postMessage({ source: "ops-browser-extension", type: "WEB_SESSION", session }, location.origin);
    } catch (_) {}
  }

  setInterval(pollWebSession, 4000);
  setTimeout(pollWebSession, 0);

  function revealSettingsButton() {
    document.querySelectorAll(".desktop-app-settings-btn").forEach((button) => {
      button.hidden = false;
      button.style.removeProperty("display");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", revealSettingsButton, { once: true });
  else revealSettingsButton();
  function watchForSettingsButton() {
    if (!document.documentElement) {
      setTimeout(watchForSettingsButton, 0);
      return;
    }
    new MutationObserver(revealSettingsButton).observe(document.documentElement, { childList: true, subtree: true });
  }
  watchForSettingsButton();

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".desktop-app-settings-btn");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.postMessage({ source: "ops-browser-extension", type: "OPEN_EXTENSION_POPUP" }, location.origin);
  }, true);
})();
