importScripts("debug_preferences.js", "debug_log.js");

const DESKTOP_HEADER = "x-ops-desktop-client";
const CLIENT_OS_HEADER = "X-OPS-Client-OS";
const OFFSCREEN_URL = "offscreen.html";
const RECONNECT_ALARM = "ops-reconnect";
const LOGIN_NOTIFICATION = "ops-managed-login";
const GUEST_READY_NOTIFICATION = "ops-guest-connected";
const PROVISIONING_TIMEOUT = 30000;
const MANAGED_SETTING_TYPES = {
  serverAddress: "string", fullScreenEmergency: "boolean", chromeOSOnly: "boolean", debug: "boolean",
  hideLoggedOffBanner: "boolean", hideGuestLoginPrompt: "boolean",
  hideDashboardButton: "boolean", hideServerAddress: "boolean"
};

let initialization = null;
let initializationPending = false;
let managedSettingsTask = chrome.storage.session.get("lastManagedSettings")
  .then(({ lastManagedSettings = {} }) => lastManagedSettings);
let provisioningStart = chrome.storage.session.get("provisioningDeadline")
  .then(async ({ provisioningDeadline }) => {
    if (provisioningDeadline) return provisioningDeadline;
    const deadline = Date.now() + PROVISIONING_TIMEOUT;
    await chrome.storage.session.set({ provisioningDeadline: deadline });
    return deadline;
  });

let socket = null;
let socketToken = "";
let reconnectTimer = null;
let pingTimer = null;
let disconnectTimer = null;
let reconnectDelay = 2000;
let connected = false;
let offlineNotified = false;
let visualState = "idle";
let receivingTimer = null;
let receivingBroadcastId = null;
let authEpoch = 0;
let chromeOSAttempt = null;
let chromeOSRetryAfter = 0;
let seenBroadcasts = new Set();
let liveAudioId = "";
let queuedAudioFrames = [];
let liveAudioStart = Promise.resolve();
let sendingAudioFrames = null;
let liveFrameCount = 0;
let droppedFrameCount = 0;
let creatingOffscreen = null;
const actionIconCache = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  if (details.reason === "update") {
    const { token } = await chrome.storage.local.get(["token"]);
    if (token) await chrome.storage.local.set({ connectionWelcomeShown: true });
  }
  await updateAction("idle");
  await initializeRuntime();
});

chrome.runtime.onStartup.addListener(initializeRuntime);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    initializeRuntime();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "managed") {
    managedSettingsTask = managedSettingsTask.then(async (cached) => {
      const settings = { ...cached };
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.hasOwn(MANAGED_SETTING_TYPES, key)) continue;
        const value = managedSettingValue(key, change.newValue);
        if (value === undefined) delete settings[key];
        else settings[key] = value;
      }
      await chrome.storage.session.set({ lastManagedSettings: settings });
      return settings;
    });
    authEpoch += 1;
    chromeOSRetryAfter = 0;
    initializeRuntime();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type && !["GET_STATE", "OFFSCREEN_READY"].includes(message.type) && !message.target) {
      debugEvent("Extension message", { type: message.type });
    }
    switch (message?.type) {
      case "GET_STATE":
        sendResponse(await getPublicState());
        break;
      case "CONFIGURE_SERVER":
        if ((await getEffectivePreferences()).hideServerAddress) sendResponse({ ok: false, managed: true });
        else sendResponse(await configureServer(message.value));
        break;
      case "WEB_SESSION":
        sendResponse(await acceptWebSession(message.session, sender));
        break;
      case "WEB_LOGOUT":
        sendResponse(await acceptWebLogout(sender));
        break;
      case "ENABLE_PAGE_BRIDGE":
        sendResponse(await enablePageBridge(sender));
        break;
      case "OPEN_EXTENSION_POPUP":
        await openExtensionPopup();
        sendResponse({ ok: true });
        break;
      case "DISCONNECT":
        if ((await getEffectivePreferences()).managed.serverAddress) sendResponse({ ok: false, managed: true });
        else {
          await disconnectAndClear();
          sendResponse({ ok: true });
        }
        break;
      case "OPEN_DASHBOARD": {
        const preferences = await getEffectivePreferences();
        if (!preferences.hideDashboardButton) await openServerPath("/dashboard");
        sendResponse({ ok: true });
        break;
      }
      case "OPEN_LOGIN":
        await openServerPath("/");
        sendResponse({ ok: true });
        break;
      case "SET_DEBUG":
        if (typeof (await getManagedSettings()).debug === "boolean") {
          sendResponse({ ok: false, managed: true });
        } else {
          await chrome.storage.local.set({ debug: message.value === true, provisioningComplete: true });
          sendResponse({ ok: true });
        }
        break;
      case "SET_FULLSCREEN_EMERGENCY":
        if ((await getManagedSettings()).fullScreenEmergency !== undefined) sendResponse({ ok: false, managed: true });
        else {
          await chrome.storage.local.set({ fullScreenEmergency: Boolean(message.value), provisioningComplete: true });
          sendResponse({ ok: true });
        }
        break;
      case "SET_CHROMEOS_ONLY":
        if ((await getEffectivePreferences()).managed.chromeOSOnly) sendResponse({ ok: false, managed: true });
        else {
          await chrome.storage.local.set({ chromeOSOnly: Boolean(message.value), provisioningComplete: true });
          await initializeRuntime();
          sendResponse({ ok: true });
        }
        break;
      case "GET_EMERGENCY": {
        const result = await chrome.storage.session.get(`emergency:${message.id}`);
        sendResponse(result[`emergency:${message.id}`] || null);
        break;
      }
      case "CLOSE_EMERGENCY":
        if (message.id) await chrome.storage.session.remove(`emergency:${message.id}`);
        if (sender.tab?.windowId != null) await chrome.windows.remove(sender.tab.windowId);
        sendResponse({ ok: true });
        break;
      case "PLAYBACK_ENDED":
        if (sender.url === chrome.runtime.getURL(OFFSCREEN_URL)) await finishReceiving(message.broadcastId);
        sendResponse({ ok: true });
        break;
      case "OFFSCREEN_READY":
        await flushAudioFrames();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown request" });
    }
  })().catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
  return true;
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  await chrome.notifications.clear(notificationId);
  if ((await getEffectivePreferences()).hideServerAddress) return;
  if (notificationId === LOGIN_NOTIFICATION) {
    await openManagedLogin();
  } else {
    await openServerPath(notificationId === GUEST_READY_NOTIFICATION ? "/" : "/dashboard");
  }
});

function initializeRuntime() {
  initializationPending = true;
  if (!initialization) {
    initialization = (async () => {
      while (initializationPending) {
        initializationPending = false;
        await initializeReceiver();
        await updateManagedLoginNotification();
      }
    })().catch(error => debugEvent("Receiver initialization failed", { message: friendlyError(error) }))
      .finally(() => { initialization = null; });
  }
  return initialization;
}

async function isProvisioning(preferences) {
  const local = await chrome.storage.local.get([
    "provisioningComplete", "origin", "serverInput", "chromeOSOnly", "fullScreenEmergency"
  ]);
  if (local.provisioningComplete) return false;
  const configured = local.origin || local.serverInput || typeof local.chromeOSOnly === "boolean" ||
    local.fullScreenEmergency === false;
  if (!configured && !preferences.hasManagedSettings && Date.now() < await provisioningStart) return true;
  await chrome.storage.local.set({ provisioningComplete: true });
  return false;
}

async function initializeReceiver() {
  let preferences = await getEffectivePreferences();
  while (await isProvisioning(preferences)) {
    await new Promise(resolve => setTimeout(resolve, 500));
    preferences = await getEffectivePreferences();
  }
  debugEvent("Receiver initialization", {
    isChromeOS: preferences.isChromeOS, extensionDisabled: preferences.extensionDisabled,
    managedServer: Boolean(preferences.serverAddress)
  });
  if (preferences.extensionDisabled) {
    clearTimeout(reconnectTimer);
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
    await closeSocket();
    await sendOffscreen({ type: "STOP_AUDIO" });
    await updateAction("idle");
    return;
  }
  if (preferences.serverAddress) {
    const current = await chrome.storage.local.get(["serverInput", "origin"]);
    if (!managedServerMatches(preferences, current)) {
      await closeSocket();
      try {
        await configureServer(preferences.serverAddress, { openLogin: false });
      } catch (_) {
        await updateAction("failed");
        scheduleOfflineNotification();
      }
      return;
    }
  }
  const state = await chrome.storage.local.get(["origin", "token", "chromeOSExpiresAt"]);
  if (state.chromeOSExpiresAt && (!managedChromeOSOrigin(preferences, state.origin) ||
      Date.now() >= state.chromeOSExpiresAt * 1000)) {
    await closeSocket();
    await chrome.storage.local.remove(["token", "refreshToken", "chromeOSExpiresAt", "userId", "role"]);
  }
  await tryChromeOSLogin(preferences);
  await connectFromStorage();
}

async function updateManagedLoginNotification() {
  const preferences = await getEffectivePreferences();
  const state = await chrome.storage.local.get(["origin", "serverInput", "productName", "token"]);
  const serverReady = managedServerMatches(preferences, state);
  if (!preferences.serverAddress || preferences.hideLoggedOffBanner || (serverReady && state.token)) {
    await chrome.notifications.clear(LOGIN_NOTIFICATION);
    return;
  }

  const { loginNotificationServer } = await chrome.storage.session.get("loginNotificationServer");
  const notificationKey = JSON.stringify([preferences.serverAddress, preferences.hideServerAddress]);
  if (loginNotificationServer === notificationKey) return;
  const product = serverReady && state.productName || "Open Paging Server";
  await showNotification(
    preferences.hideServerAddress ? `Unable to login to ${product}` : `Login to ${product} to receive important broadcasts`,
    preferences.hideServerAddress
      ? "You won't be able to receive important broadcasts such as pages and emergency messages from your organization. Contact your system administrator for help."
      : `Click here to login to ${product}. You must login to receive pages and emergency messages from your organization. You'll only need to do this once on this computer.`,
    { id: LOGIN_NOTIFICATION }
  );
  await chrome.storage.session.set({ loginNotificationServer: notificationKey });
}

async function openManagedLogin() {
  const preferences = await getEffectivePreferences();
  if (!preferences.serverAddress || preferences.hideLoggedOffBanner || preferences.hideServerAddress) return;
  const state = await chrome.storage.local.get(["origin", "serverInput"]);
  const address = preferences.serverAddress;
  const url = managedServerMatches(preferences, state)
    ? new URL(state.origin)
    : new URL(address.includes("://") ? address : `https://${address}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  await chrome.tabs.create({ url: `${url.origin}/?desktop_client=1`, active: true });
}

function managedServerMatches(preferences, state) {
  return Boolean(state.origin) && (!preferences.serverAddress || state.serverInput === preferences.serverAddress);
}

function managedChromeOSOrigin(preferences, origin) {
  if (!preferences.isChromeOS || !preferences.serverAddress || !origin) return false;
  try {
    const address = preferences.serverAddress;
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === origin;
  } catch (_) {
    return false;
  }
}

async function tryChromeOSLogin(preferences) {
  if (chromeOSAttempt) return chromeOSAttempt;
  const epoch = authEpoch;
  chromeOSAttempt = (async () => {
    const state = await chrome.storage.local.get(["origin", "token", "role", "chromeOSExpiresAt"]);
    if (!preferences.isChromeOS || !preferences.serverAddress || state.chromeOSExpiresAt ||
        Date.now() < chromeOSRetryAfter) return false;
    if (!managedChromeOSOrigin(preferences, state.origin)) {
      debugEvent("Auto-login requires the managed HTTPS address to match the connected server.");
      return false;
    }
    if (!chrome.enterprise?.platformKeys?.challengeKey) {
      debugEvent("Chrome Verified Access is unavailable on this Chromebook.");
      return false;
    }
    const endpoint = `${state.origin}/desktop/session/chromeos`;
    const options = { method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(25000) };
    if (state.token && state.role !== "guest") {
      const status = await fetchJson(`${state.origin}/desktop/session/ping`, {
        ...options, method: "GET", headers: { Authorization: `Bearer ${state.token}` }
      }).catch(() => null);
      if (status && !status.reauth_required) return false;
      if (!status && !desktopTokenExpired(state.token)) return false;
    }
    chromeOSRetryAfter = Date.now() + 5 * 60 * 1000;
    debugEvent("Checking the Chromebook profile…");
    const { email } = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    if (epoch !== authEpoch) return false;
    if (!email) {
      debugEvent("Chrome did not provide a signed-in profile email.");
      return false;
    }
    debugEvent("Requesting a verification challenge from OPS…");
    const challenge = await fetchJson(endpoint, { ...options, body: JSON.stringify({ email }) });
    debugEvent("Checking Chrome’s enterprise challenge permission…");
    const signed = await chrome.enterprise.platformKeys.challengeKey({
      challenge: Uint8Array.from(atob(challenge.challenge), byte => byte.charCodeAt(0)).buffer,
      scope: "USER"
    });
    const challengeResponse = btoa(Array.from(new Uint8Array(signed), byte => String.fromCharCode(byte)).join(""));
    debugEvent("Waiting for OPS to verify the signed challenge…");
    const session = await fetchJson(endpoint, {
      ...options, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ email, request_id: challenge.request_id, challengeResponse })
    });
    if (epoch !== authEpoch || !session.chromeos_auto_login || !session.reauth_required ||
        !session.token || !Number.isFinite(session.expires_at)) return false;
    authEpoch += 1;
    await saveSession(session);
    debugEvent("Verified Access session established", { expiresAt: session.expires_at });
    return true;
  })().catch(async (error) => {
    if (epoch !== authEpoch) return false;
    debugEvent("Verified Access failed", { name: error.name, message: friendlyError(error) });
    return false;
  }).finally(() => { chromeOSAttempt = null; });
  return chromeOSAttempt;
}

function desktopTokenExpired(token) {
  try {
    const encoded = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return Date.now() >= JSON.parse(atob(encoded)).exp * 1000;
  } catch (_) {
    return false;
  }
}

async function configureServer(input, options = {}) {
  const preferences = await getEffectivePreferences();
  if (await isProvisioning(preferences)) throw new Error("Provisioning environment... Please wait");
  const raw = preferences.serverAddress || String(input || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Please enter a server address.");
  const candidates = raw.includes("://") ? [raw] : [`https://${raw}`, `http://${raw}`];
  let lastError = new Error("Could not reach the server.");
  for (const candidate of candidates) {
    try {
      const response = await debugFetch(`${candidate}/desktop/server-info`, {
        headers: clientHeaders(),
        redirect: "follow", signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
      const info = await response.json();
      validateServerInfo(info);
      const finalUrl = new URL(response.url);
      const origin = finalUrl.origin;
      if (!connected && !socket) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      const current = await getEffectivePreferences();
      if (current.serverAddress && current.serverAddress !== raw) throw new Error("The managed server address changed.");
      authEpoch += 1;
      await closeSocket();
      await chrome.storage.local.set({
        serverInput: raw,
        provisioningComplete: true,
        origin,
        productName: String(info.product_name || "Open Paging Server"),
        guestAvailable: Boolean(info.guest_receiver_enabled),
        serverInfo: info,
        token: "",
        refreshToken: "",
        chromeOSExpiresAt: 0,
        role: "",
        userId: null,
        connectionWelcomeShown: false
      });
      await updateAction("loggedout");
      if (await tryChromeOSLogin(await getEffectivePreferences())) return { ok: true, origin, info, guest: false };
      if (info.guest_receiver_enabled) {
        try {
          const guest = await fetchJson(`${origin}/desktop/session/guest`, { method: "POST" });
          await saveSession(guest);
          if (options.openLogin !== false) await chrome.tabs.create({ url: `${origin}/?desktop_client=1`, active: true });
          return { ok: true, origin, info, guest: true };
        } catch (_) {
        }
      }
      if (options.openLogin !== false) await chrome.tabs.create({ url: `${origin}/?desktop_client=1`, active: true });
      return { ok: true, origin, info, guest: false };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not reach the server: ${friendlyError(lastError)}`);
}

function validateServerInfo(info) {
  if (!info || !String(info.product_name || "").trim()) {
    throw new Error("The server did not identify itself as Open Paging Server.");
  }
  if (info.websocket_path !== "/desktop/ws" || info.keepalive_path !== "/desktop/session/ping") {
    throw new Error("The server did not return a valid browser client configuration.");
  }
}

async function acceptWebSession(session, sender) {
  const preferences = await getEffectivePreferences();
  if (preferences.extensionDisabled) return { ok: false, disabled: true };
  const state = await chrome.storage.local.get(["origin", "serverInput"]);
  if (!managedServerMatches(preferences, state) || !sender.tab?.url || new URL(sender.tab.url).origin !== state.origin) {
    return { ok: false };
  }
  if (!session?.token) return { ok: false };
  if (session.reauth_required && (await chrome.storage.local.get("chromeOSExpiresAt")).chromeOSExpiresAt) return { ok: true };
  authEpoch += 1;
  await saveSession(session);
  return { ok: true };
}

async function acceptWebLogout(sender) {
  const state = await chrome.storage.local.get(["origin", "token", "role", "chromeOSExpiresAt"]);
  if (!state.token || state.role === "guest" || state.chromeOSExpiresAt) return { ok: true };
  if (!state.origin || !sender.tab?.url || new URL(sender.tab.url).origin !== state.origin) return { ok: false };
  authEpoch += 1;
  clearTimeout(reconnectTimer);
  clearTimeout(disconnectTimer);
  disconnectTimer = null;
  await closeSocket();
  await sendOffscreen({ type: "STOP_AUDIO" });
  await chrome.storage.local.remove(["token", "refreshToken", "chromeOSExpiresAt", "role", "userId"]);
  socketToken = "";
  offlineNotified = false;
  await updateAction("loggedout");
  return { ok: true };
}

async function enablePageBridge(sender) {
  const state = await chrome.storage.local.get(["origin"]);
  if (!state.origin || !sender.tab?.id || !sender.tab.url || new URL(sender.tab.url).origin !== state.origin) return { ok: false };
  await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", files: ["page_bridge.js"] });
  return { ok: true };
}

async function openExtensionPopup() {
  if (chrome.action.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (_) {}
  }
  await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?window=1"), type: "popup", width: 380, height: 560, focused: true });
}

async function saveSession(session) {
  const old = await chrome.storage.local.get(["token", "refreshToken", "userId", "role"]);
  const user = session.user || {};
  const identityChanged = old.userId !== user.id || old.role !== String(user.role || "");
  const newToken = String(session.token || "");
  const tokenChanged = old.token !== newToken;
  const oldIdentity = desktopTokenIdentity(old.token);
  const newIdentity = desktopTokenIdentity(newToken);
  const sameLiveIdentity = Boolean(
    (oldIdentity[0] && newIdentity[0] && oldIdentity.join("\u0000") === newIdentity.join("\u0000")) ||
    (!oldIdentity[0] && !newIdentity[0] && !identityChanged)
  );
  await chrome.storage.local.set({
    token: newToken,
    refreshToken: session.chromeos_auto_login ? "" : String(session.refresh_token || old.refreshToken || ""),
    chromeOSExpiresAt: session.chromeos_auto_login ? session.expires_at : 0,
    role: String(user.role || ""),
    userId: user.id ?? null
  });
  if (newToken) await chrome.notifications.clear(LOGIN_NOTIFICATION);
  if (identityChanged) seenBroadcasts = new Set();
  if (tokenChanged && !sameLiveIdentity) await closeSocket();
  if (sameLiveIdentity && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  await connectFromStorage();
}

async function connectFromStorage() {
  const preferences = await getEffectivePreferences();
  if (preferences.extensionDisabled) return;
  const state = await chrome.storage.local.get(["origin", "serverInput", "token", "productName", "role"]);
  if (!managedServerMatches(preferences, state)) return;
  if (!state.token) {
    await updateAction("loggedout");
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) && socketToken === state.token) return;
  clearTimeout(reconnectTimer);
  socketToken = state.token;
  await updateAction("standby");
  const wsOrigin = state.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const ws = new WebSocket(`${wsOrigin}/desktop/ws?token=${encodeURIComponent(state.token)}`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  debugEvent("WebSocket connecting", { url: debugUrl(ws.url) });
  ws.onopen = async () => {
    if (socket !== ws) return;
    connected = true;
    debugEvent("WebSocket connected");
    reconnectDelay = 2000;
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
    await updateAction("connected");
    if (offlineNotified) {
      offlineNotified = false;
      await showReadyNotification(state, true);
    } else {
      const { connectionWelcomeShown = false } = await chrome.storage.local.get(["connectionWelcomeShown"]);
      if (!connectionWelcomeShown) {
        await chrome.storage.local.set({ connectionWelcomeShown: true });
        await showReadyNotification(state, false);
      }
    }
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  };
  ws.onmessage = (event) => handleSocketMessage(event.data);
  ws.onerror = () => debugEvent("WebSocket error");
  ws.onclose = async (event) => {
    debugEvent("WebSocket closed", { code: event.code, reason: event.reason, clean: event.wasClean });
    if (socket !== ws) return;
    socket = null;
    connected = false;
    clearTimeout(receivingTimer);
    receivingBroadcastId = null;
    clearInterval(pingTimer);
    await updateAction("failed");
    scheduleOfflineNotification();
    await tryRefreshSession();
    scheduleReconnect();
  };
}

async function showReadyNotification(state, reconnecting) {
  const product = state.productName || "Open Paging Server";
  const { hideGuestLoginPrompt } = await getEffectivePreferences();
  const guestPrompt = state.role === "guest" && !hideGuestLoginPrompt;
  let message = reconnecting
    ? "You will now be able to receive pages and emergency notifications."
    : "You are now ready to receive pages and emergency notifications from your organization.";
  if (guestPrompt) {
    message += `\nYou'll need to login to ${product} to receive broadcasts targeted to you. You'll only need to do this once on this computer.`;
  }
  await showNotification(
    `${reconnecting ? "Reconnected" : "Connected"} to ${product}`,
    message,
    { id: guestPrompt ? GUEST_READY_NOTIFICATION : reconnecting ? undefined : "ops-connected" }
  );
}

async function tryRefreshSession() {
  const epoch = authEpoch;
  const state = await chrome.storage.local.get(["origin", "serverInput", "refreshToken"]);
  if (!state.refreshToken || !managedServerMatches(await getEffectivePreferences(), state)) return false;
  try {
    const session = await fetchJson(`${state.origin}/desktop/session/refresh`, {
      method: "POST",
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });
    if (epoch !== authEpoch) return false;
    if (!session?.token) return false;
    await saveSession(session);
    return true;
  } catch (_) {
    return false;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  reconnectTimer = setTimeout(connectFromStorage, delay);
}

function scheduleOfflineNotification() {
  if (disconnectTimer || offlineNotified) return;
  disconnectTimer = setTimeout(async () => {
    disconnectTimer = null;
    if (connected || offlineNotified) return;
    offlineNotified = true;
    const state = await chrome.storage.local.get(["origin", "serverInput", "productName"]);
    const preferences = await getEffectivePreferences();
    const productName = managedServerMatches(preferences, state) && state.productName || "Open Paging Server";
    await showNotification(`Unable to connect to ${productName}`, "You won't be able to receive pages and emergency notifications. We'll retry the connection in the background.");
  }, 30000);
}

async function handleSocketMessage(data) {
  if (typeof data === "string") {
    let message;
    try { message = JSON.parse(data); } catch (_) { return; }
    if (message?.type !== "pong") debugEvent("WebSocket message", {
      type: message?.type, broadcastId: message?.broadcast_id, audioMode: message?.audio_mode,
      codec: message?.audio_codec, sampleRate: message?.audio_sample_rate, priority: message?.priority
    });
    if (message?.type === "broadcast") await handleBroadcast(message);
    return;
  }
  const bytes = new Uint8Array(data);
  if (bytes.length < 33) return;
  const packetType = String.fromCharCode(bytes[0]);
  const broadcastId = new TextDecoder().decode(bytes.slice(1, 33)).trim();
  if (packetType === "A" && broadcastId === liveAudioId) {
    queuedAudioFrames.push({ broadcastId, bytes: Array.from(bytes.slice(33)) });
    liveFrameCount += 1;
    if (queuedAudioFrames.length > 120) {
      queuedAudioFrames.shift();
      droppedFrameCount += 1;
    }
    await flushAudioFrames();
  } else if (packetType === "E" && broadcastId === liveAudioId) {
    liveAudioId = "";
    await liveAudioStart;
    await flushAudioFrames();
    await sendOffscreen({ type: "AUDIO_END", broadcastId });
  }
}

async function handleBroadcast(message) {
  const id = String(message.broadcast_id || "");
  if (id && seenBroadcasts.has(id)) return;
  if (id) seenBroadcasts.add(id);
  if (message.late) return;
  const shortText = String(message.shortmessage || "").trim();
  const longText = String(message.longmessage || "").trim();
  const priority = String(message.priority || "Normal").toLowerCase();
  const hasAudio = Boolean(message.has_audio && id);
  const receiving = startReceiving(id, hasAudio);
  if (hasAudio) {
    const mode = String(message.audio_mode || "").toLowerCase();
    const codec = String(message.audio_codec || "mulaw").toLowerCase();
    const supportedCodec = ["mulaw", "ulaw", "pcmu", "pcm_s16le_48k_stereo", "s16le48", "pcm"].includes(codec);
    if (supportedCodec && ["live", "websocket", "mulaw", "ulaw"].includes(mode)) {
      liveAudioId = id;
      queuedAudioFrames = [];
      liveAudioStart = ensureOffscreen().then(() => sendOffscreen({
        type: "AUDIO_START", broadcastId: id,
        codec, sampleRate: message.audio_sample_rate
      })).catch(() => finishReceiving(id));
      await liveAudioStart;
    } else {
      try {
        await ensureOffscreen();
        const state = await chrome.storage.local.get(["origin", "token"]);
        await sendOffscreen({ type: "PLAY_RECORDING", origin: state.origin, token: state.token, broadcastId: id });
      } catch (_) {
        await finishReceiving(id);
      }
    }
  }
  await receiving;
  if (message.product_name) await chrome.storage.local.set({ productName: String(message.product_name) });
  if (!shortText && !longText) return;
  if (priority === "emergency") {
    await showEmergency(message);
  } else if (priority === "high" && !(await getEffectivePreferences()).hideServerAddress) {
    await openServerPath("/dashboard");
  } else {
    let iconUrl = "icons/icon128.png";
    try { iconUrl = await fetchBroadcastIcon(id); } catch (_) {}
    await showNotification(shortText || "Open Paging Server", longText, {
      iconUrl,
      requireInteraction: priority !== "low",
      silent: Boolean(message.has_audio)
    });
  }
}

async function showEmergency(message) {
  const id = crypto.randomUUID();
  const preferences = await getEffectivePreferences();
  const fullScreenEmergency = preferences.fullScreenEmergency;
  let iconDataUrl = "";
  try { iconDataUrl = await fetchBroadcastIcon(String(message.broadcast_id || "")); } catch (_) {}
  await chrome.storage.session.set({ [`emergency:${id}`]: { ...message, iconDataUrl, fullScreenEmergency } });
  const windowOptions = {
    url: chrome.runtime.getURL(`emergency.html?id=${encodeURIComponent(id)}`),
    type: "popup",
    focused: true
  };
  if (fullScreenEmergency) windowOptions.state = "fullscreen";
  else {
    windowOptions.width = 900;
    windowOptions.height = 650;
  }
  const emergencyWindow = await chrome.windows.create(windowOptions);
  if (fullScreenEmergency && emergencyWindow?.id != null) {
    await chrome.windows.update(emergencyWindow.id, { state: "fullscreen", focused: true });
  }
}

async function fetchBroadcastIcon(broadcastId) {
  if (!broadcastId) return "icons/icon128.png";
  const state = await chrome.storage.local.get(["origin", "token"]);
  const response = await debugFetch(`${state.origin}/desktop/broadcasts/${encodeURIComponent(broadcastId)}/icon`, {
    headers: { ...clientHeaders(), Authorization: `Bearer ${state.token}` }
  });
  if (!response.ok) throw new Error("Icon download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${response.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`;
}

async function showNotification(title, message, options = {}) {
  const id = options.id || `ops-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await chrome.notifications.create(id, {
    type: "basic",
    title: String(title || "Open Paging Server"),
    message: String(message || ""),
    iconUrl: options.iconUrl || "icons/icon128.png",
    requireInteraction: Boolean(options.requireInteraction),
    silent: Boolean(options.silent)
  });
}

async function openServerPath(path) {
  const state = await chrome.storage.local.get(["origin", "serverInput"]);
  const preferences = await getEffectivePreferences();
  if (!preferences.hideServerAddress && !preferences.extensionDisabled && managedServerMatches(preferences, state)) {
    const { origin } = state;
    const separator = path.includes("?") ? "&" : "?";
    await chrome.tabs.create({ url: `${origin}${path}${separator}desktop_client=1`, active: true });
  }
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play live and recorded emergency broadcast audio."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendOffscreen(message) {
  if (message.type !== "AUDIO_FRAMES") debugEvent("Audio command", {
    type: message.type, broadcastId: message.broadcastId, codec: message.codec, sampleRate: message.sampleRate
  });
  try { await chrome.runtime.sendMessage({ ...message, target: "offscreen" }); } catch (_) {}
}

async function flushAudioFrames() {
  if (sendingAudioFrames) return sendingAudioFrames;
  if (!queuedAudioFrames.length) return;
  sendingAudioFrames = (async () => {
    await liveAudioStart;
    while (queuedAudioFrames.length) {
      const batch = queuedAudioFrames.splice(0, queuedAudioFrames.length);
      await sendOffscreen({ type: "AUDIO_FRAMES", frames: batch });
    }
  })().finally(() => { sendingAudioFrames = null; });
  return sendingAudioFrames;
}

async function closeSocket() {
  clearTimeout(receivingTimer);
  receivingBroadcastId = null;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (socket) {
    const old = socket;
    socket = null;
    old.onclose = null;
    old.close();
  }
  connected = false;
}

async function disconnectAndClear() {
  authEpoch += 1;
  await closeSocket();
  await sendOffscreen({ type: "STOP_AUDIO" });
  await chrome.storage.local.remove(["origin", "serverInput", "serverInfo", "productName", "guestAvailable", "token", "refreshToken", "role", "userId", "chromeOSExpiresAt", "connectionWelcomeShown"]);
  seenBroadcasts.clear();
  offlineNotified = false;
  await updateAction("idle");
}

async function startReceiving(broadcastId, hasAudio) {
  clearTimeout(receivingTimer);
  receivingBroadcastId = broadcastId;
  if (!hasAudio) receivingTimer = setTimeout(() => finishReceiving(broadcastId), 10000);
  await updateAction("receiving");
}

async function finishReceiving(broadcastId) {
  if (receivingBroadcastId !== broadcastId) return;
  clearTimeout(receivingTimer);
  receivingBroadcastId = null;
  await updateAction(connected ? "connected" : "failed");
}

async function updateAction(state) {
  visualState = state;
  const colors = { connected: "#2E7D32", standby: "#2E7D32", failed: "#C62828", receiving: "#1565C0", loggedout: "#757575" };
  const titles = { connected: "Connected", standby: "Standby", failed: "Connection failed", receiving: "Incoming broadcast", loggedout: "Logged out" };
  const active = Boolean(colors[state]);
  await chrome.action.setBadgeText({ text: "" });
  await setActionStatusIcon(active ? colors[state] : "");
  await chrome.action.setTitle({ title: active ? `Open Paging Server — ${titles[state]}` : "Open Paging Server" });
  await chrome.storage.session.set({ runtimeStatus: state });
}

async function setActionStatusIcon(color) {
  const key = color || "idle";
  if (actionIconCache.has(key)) {
    await chrome.action.setIcon({ imageData: actionIconCache.get(key) });
    return;
  }
  const imageData = {};
  for (const size of [16, 32]) {
    const response = await debugFetch(chrome.runtime.getURL(`icons/icon${size}.png`));
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, size, size);
    if (color) {
      const radius = Math.max(2, Math.round(size * 0.17));
      const center = size - radius - 1;
      context.beginPath();
      context.arc(center, center, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    }
    imageData[size] = context.getImageData(0, 0, size, size);
    bitmap.close();
  }
  actionIconCache.set(key, imageData);
  await chrome.action.setIcon({ imageData });
}

async function getPublicState() {
  const state = await chrome.storage.local.get(["origin", "serverInput", "productName", "role", "userId", "token", "chromeOSExpiresAt", "fullScreenEmergency"]);
  const session = await chrome.storage.session.get(["runtimeStatus"]);
  const preferences = await getEffectivePreferences();
  const serverReady = managedServerMatches(preferences, state);
  const debug = await readDebugPreferences();
  return {
    ...state,
    origin: serverReady && !preferences.hideServerAddress ? state.origin : "",
    serverInput: preferences.hideServerAddress ? "" : state.serverInput,
    serverConfigured: serverReady || Boolean(preferences.serverAddress),
    token: serverReady && Boolean(state.token),
    provisioning: await isProvisioning(preferences),
    debug,
    connected,
    status: session.runtimeStatus || visualState,
    fullScreenEmergency: preferences.fullScreenEmergency,
    chromeOSOnly: preferences.chromeOSOnly,
    hideDashboardButton: preferences.hideDashboardButton,
    hideServerAddress: preferences.hideServerAddress,
    chromeOSRequiredByPolicy: preferences.chromeOSRequiredByPolicy,
    extensionDisabled: preferences.extensionDisabled,
    isChromeOS: preferences.isChromeOS,
    managed: preferences.managed,
    enforcedServerAddress: preferences.hideServerAddress ? "" : preferences.serverAddress
  };
}

function managedSettingValue(key, raw) {
  const value = raw && typeof raw === "object" ? raw.Value : raw;
  return typeof value === MANAGED_SETTING_TYPES[key] ? value : undefined;
}

function getManagedSettings() {
  managedSettingsTask = managedSettingsTask.then(async (cached) => {
    try {
      const policy = await chrome.storage.managed.get(Object.keys(MANAGED_SETTING_TYPES));
      const settings = { ...cached };
      for (const key of Object.keys(MANAGED_SETTING_TYPES)) {
        const value = managedSettingValue(key, policy[key]);
        if (value !== undefined) settings[key] = value;
      }
      if (JSON.stringify(settings) !== JSON.stringify(cached)) {
        await chrome.storage.session.set({ lastManagedSettings: settings });
      }
      return settings;
    } catch (_) {
      return cached;
    }
  });
  return managedSettingsTask;
}

async function getEffectivePreferences() {
  const [local, managed, platform] = await Promise.all([
    chrome.storage.local.get(["fullScreenEmergency", "chromeOSOnly"]),
    getManagedSettings(),
    chrome.runtime.getPlatformInfo()
  ]);
  const serverAddress = String(managed.serverAddress || "").trim().replace(/\/+$/, "");
  const fullScreenEmergency = typeof managed.fullScreenEmergency === "boolean"
    ? managed.fullScreenEmergency
    : local.fullScreenEmergency !== false;
  const hideServerAddress = managed.hideServerAddress === true;
  const chromeOSOnly = hideServerAddress || (managed.chromeOSOnly ?? (local.chromeOSOnly === true));
  const isChromeOS = platform.os === "cros";
  return {
    serverAddress,
    hasManagedSettings: Object.keys(managed).length > 0,
    hideLoggedOffBanner: managed.hideLoggedOffBanner === true,
    hideGuestLoginPrompt: hideServerAddress || managed.hideGuestLoginPrompt === true,
    hideDashboardButton: hideServerAddress || managed.hideDashboardButton === true,
    hideServerAddress,
    chromeOSRequiredByPolicy: hideServerAddress && managed.chromeOSOnly !== true,
    fullScreenEmergency,
    chromeOSOnly,
    isChromeOS,
    extensionDisabled: chromeOSOnly && !isChromeOS,
    managed: {
      serverAddress: Boolean(serverAddress),
      fullScreenEmergency: Object.prototype.hasOwnProperty.call(managed, "fullScreenEmergency"),
      chromeOSOnly: hideServerAddress || typeof managed.chromeOSOnly === "boolean"
    }
  };
}

function clientHeaders() {
  return { [DESKTOP_HEADER]: "1", [CLIENT_OS_HEADER]: "Chrome Extension" };
}

function desktopTokenIdentity(token) {
  const raw = String(token || "").trim();
  if (!raw.includes(".")) return ["", "", ""];
  const encoded = raw.slice(0, raw.lastIndexOf("."));
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(atob(normalized));
    return [
      String(payload.user_id ?? "").trim(),
      String(payload.role || "").trim().toLowerCase(),
      String(payload.sid || payload.session_id || "").trim()
    ];
  } catch (_) {
    return ["", "", ""];
  }
}

async function fetchJson(url, options = {}) {
  const response = await debugFetch(url, {
    ...options,
    headers: { ...clientHeaders(), "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function friendlyError(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

debugEvent("Service worker started", { version: chrome.runtime.getManifest().version });
initializeRuntime();
