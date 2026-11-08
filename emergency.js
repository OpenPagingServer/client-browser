const params = new URLSearchParams(location.search);
const id = params.get("id");
const closeButton = document.getElementById("close");

function readableTextColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!match) return "#fff";
  const value = parseInt(match[1], 16);
  const r = value >> 16, g = (value >> 8) & 255, b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

(async () => {
  const data = await chrome.runtime.sendMessage({ type: "GET_EMERGENCY", id });
  if (!data) return;
  const color = String(data.color || "#B71C1C");
  document.body.style.background = color;
  document.body.style.color = readableTextColor(color);
  document.getElementById("short").textContent = data.shortmessage || "";
  document.getElementById("long").textContent = data.longmessage || "";
  document.getElementById("name").textContent = data.name || "";
  const parts = [];
  if (data.issued) parts.push(`Issued ${formatDate(data.issued)}`);
  if (data.expires) parts.push(`Expires ${formatDate(data.expires)}`);
  parts.push(data.product_name || "Open Paging Server");
  if (data.sender) parts.push(`Sent by ${data.sender}`);
  document.getElementById("meta").textContent = parts.join(" · ");
  if (data.iconDataUrl) {
    const icon = document.getElementById("icon");
    icon.src = data.iconDataUrl;
    icon.hidden = false;
  }
  if (data.fullScreenEmergency === false) {
    closeButton.remove();
  } else {
    setTimeout(() => { closeButton.disabled = false; closeButton.classList.add("ready"); }, 30000);
    closeButton.addEventListener("click", async () => {
      if (closeButton.disabled || !confirm("Are you sure you would like to close?")) return;
      await chrome.runtime.sendMessage({ type: "CLOSE_EMERGENCY", id });
    });
  }
})();
