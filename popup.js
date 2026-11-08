const server = document.getElementById("server");
const connect = document.getElementById("connect");
const configuration = document.getElementById("configuration");
const dashboard = document.getElementById("dashboard");
const signin = document.getElementById("signin");
const settings = document.getElementById("settings");
const mainView = document.getElementById("main-view");
const settingsView = document.getElementById("settings-view");
const settingsIconPath = document.getElementById("settings-icon-path");
const fullscreenEmergency = document.getElementById("fullscreen-emergency");
const chromeOSOnly = document.getElementById("chromeos-only");
const desktopOnlyView = document.getElementById("desktop-only-view");
const receiverView = document.getElementById("receiver-view");
const fullscreenSetting = document.getElementById("fullscreen-setting");
const chromeOSSetting = document.getElementById("chromeos-setting");
const serverSetting = document.getElementById("server-setting");
const settingsServerAddress = document.getElementById("settings-server-address");
const fullscreenManaged = document.getElementById("fullscreen-managed");
const chromeOSManaged = document.getElementById("chromeos-managed");
const serverManaged = document.getElementById("server-managed");
const disconnect = document.getElementById("disconnect");
const connection = document.getElementById("connection");
const message = document.getElementById("message");
const debugSetting = document.getElementById("debug-setting");
const debugToggle = document.getElementById("debug-toggle");
const debugLabel = document.getElementById("debug-setting-label");
const debugManaged = document.getElementById("debug-managed");
let debugSettings = { enabled: false, managed: true };
let debugRevealed = false;
let debugKeys = "";

function renderDebugSetting() {
  debugSetting.hidden = !(debugSettings.enabled || (!debugSettings.managed && debugRevealed));
  debugSetting.classList.toggle("managed", debugSettings.managed);
  debugManaged.toggleAttribute("hidden", !debugSettings.managed);
  debugToggle.disabled = debugSettings.managed;
  debugToggle.checked = debugSettings.enabled;
  debugLabel.textContent = debugSettings.enabled ? "Debug" : "SQUASH SOME BUGS!!!!!";
  debugLink.hidden = !debugSettings.enabled;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  debugSettings = state.debug || { enabled: false, managed: true };
  if (debugSettings.managed) debugRevealed = false;
  renderDebugSetting();
  const provisioning = Boolean(state.provisioning);
  document.getElementById("provisioning").hidden = !provisioning;
  settings.hidden = provisioning;
  if (provisioning) {
    setSettingsOpen(false);
    aboutView.hidden = true;
    mainView.hidden = true;
    return;
  }
  mainView.hidden = !settingsView.hidden || !aboutView.hidden;
  server.value = state.enforcedServerAddress || state.serverInput || state.origin || server.value;
  const configured = state.serverConfigured;
  const signedIn = Boolean(state.token);
  desktopOnlyView.hidden = !state.extensionDisabled;
  receiverView.hidden = state.extensionDisabled;
  connection.hidden = !configured;
  const status = state.status || (state.connected ? "connected" : configured ? "failed" : "idle");
  connection.className = `status ${status}`;
  const labels = {
    receiving: "Incoming broadcast",
    connected: `Connected to ${state.productName || "Open Paging Server"}`,
    standby: `Standby — ${state.productName || "Open Paging Server"}`,
    loggedout: "Logged out",
    failed: "Connection failed",
    idle: ""
  };
  connection.querySelector("b").textContent = labels[status] || labels.idle;
  configuration.hidden = configured || state.hideServerAddress;
  signin.hidden = state.hideServerAddress || !state.origin || (signedIn && !state.chromeOSExpiresAt);
  dashboard.hidden = state.hideDashboardButton || !signedIn || Boolean(state.chromeOSExpiresAt);
  fullscreenEmergency.checked = state.fullScreenEmergency !== false;
  chromeOSOnly.checked = state.chromeOSOnly === true;
  const managed = state.managed || {};
  fullscreenEmergency.disabled = Boolean(managed.fullScreenEmergency);
  chromeOSOnly.disabled = Boolean(managed.chromeOSOnly);
  fullscreenSetting.classList.toggle("managed", Boolean(managed.fullScreenEmergency));
  chromeOSSetting.classList.toggle("managed", Boolean(managed.chromeOSOnly));
  fullscreenManaged.toggleAttribute("hidden", !managed.fullScreenEmergency);
  chromeOSManaged.toggleAttribute("hidden", !managed.chromeOSOnly);
  const chromeOSPolicyHint = state.chromeOSRequiredByPolicy ? "Required by other policy" : "Managed by your administrator";
  chromeOSManaged.setAttribute("aria-label", chromeOSPolicyHint);
  chromeOSManaged.querySelector("title").textContent = chromeOSPolicyHint;
  serverManaged.toggleAttribute("hidden", !(managed.serverAddress || state.hideServerAddress));
  serverSetting.classList.toggle("managed", Boolean(managed.serverAddress));
  settingsServerAddress.textContent = state.hideServerAddress
    ? "Managed by your organization"
    : state.enforcedServerAddress || state.serverInput || state.origin || "";
  fullscreenSetting.hidden = false;
  serverSetting.hidden = !configured && !state.hideServerAddress;
  disconnect.hidden = !configured || Boolean(managed.serverAddress) || state.hideServerAddress;
  connect.textContent = "Connect";
}

connect.addEventListener("click", async () => {
  message.textContent = "";
  connect.disabled = true;
  connect.textContent = "Connecting…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "CONFIGURE_SERVER", value: server.value });
    if (!result?.ok) throw new Error(result?.error || "Connection failed");
    message.style.color = "#2e7d32";
    message.textContent = result.guest ? "Connected as a guest; sign in in the server tab to use your account." : "Sign in in the server tab that just opened.";
  } catch (error) {
    message.style.color = "#b71c1c";
    message.textContent = error.message || String(error);
  } finally {
    connect.disabled = false;
    await refresh();
  }
});

server.addEventListener("keydown", (event) => { if (event.key === "Enter") connect.click(); });
dashboard.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }));
signin.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_LOGIN" }));
fullscreenEmergency.addEventListener("change", async () => {
  const value = fullscreenEmergency.checked;
  const result = await chrome.runtime.sendMessage({ type: "SET_FULLSCREEN_EMERGENCY", value });
  if (!result?.ok) fullscreenEmergency.checked = !value;
  await refresh();
});
chromeOSOnly.addEventListener("change", async () => {
  const value = chromeOSOnly.checked;
  const result = await chrome.runtime.sendMessage({ type: "SET_CHROMEOS_ONLY", value });
  if (!result?.ok) chromeOSOnly.checked = !value;
  await refresh();
});
const aboutView = document.getElementById("about-view");
const debugLink = document.getElementById("debug-link");
document.getElementById("about-title").textContent =
  `Open Paging Server Browser Extension ${chrome.runtime.getManifest().version}`;

document.addEventListener("keydown", event => {
  if (settingsView.hidden || debugSettings.managed || debugSettings.enabled ||
      event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
  if (event.key.length !== 1) return;
  debugKeys = (debugKeys + event.key.toLowerCase()).slice(-5);
  if (debugKeys === "debug") {
    debugRevealed = true;
    debugKeys = "";
    renderDebugSetting();
    debugToggle.focus();
  }
}, { capture: true });
debugToggle.addEventListener("change", async () => {
  debugRevealed = false;
  await chrome.runtime.sendMessage({ type: "SET_DEBUG", value: debugToggle.checked });
  await refresh();
  if (debugSetting.hidden && !settingsView.hidden) settingsView.focus();
});

document.getElementById("about").addEventListener("click", () => {
  settingsView.hidden = true;
  aboutView.hidden = false;
  refresh();
});
settings.addEventListener("click", () => {
  if (!aboutView.hidden) {
    aboutView.hidden = true;
    setSettingsOpen(true);
  } else {
    setSettingsOpen(settingsView.hidden);
  }
});
disconnect.addEventListener("click", async () => {
  if (!confirm("Disconnect from this server? You will stop receiving pages.")) return;
  await chrome.runtime.sendMessage({ type: "DISCONNECT" });
  setSettingsOpen(false);
  message.textContent = "";
  await refresh();
});

function setSettingsOpen(open) {
  debugKeys = "";
  mainView.hidden = open;
  settingsView.hidden = !open;
  if (open) settingsView.focus();
  settingsIconPath.setAttribute("d", open
    ? "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"
    : "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.62l-1.92-3.32a.49.49 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94L14.4 2.8a.48.48 0 0 0-.48-.4h-3.84a.48.48 0 0 0-.48.4l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.72 8.86a.48.48 0 0 0 .12.62l2.03 1.58c-.05.31-.08.65-.08.94s.03.63.08.94l-2.03 1.58a.49.49 0 0 0-.12.62l1.92 3.32c.12.22.38.31.6.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.04.24.24.4.48.4h3.84c.24 0 .44-.16.48-.4l.36-2.54a7.1 7.1 0 0 0 1.62-.94l2.39.96c.22.09.48 0 .6-.22l1.92-3.32a.49.49 0 0 0-.12-.62l-2.04-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z");
  settings.classList.toggle("settings-open", open);
  settings.classList.toggle("selected", open);
  settings.setAttribute("aria-label", open ? "Back" : "Settings");
  settings.title = open ? "Back" : "Settings";
}
refresh();
setInterval(() => {
  refresh();
}, 1000);
