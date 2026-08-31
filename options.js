// Force Color Scheme — options page
"use strict";

const textarea = document.getElementById("sites");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");

async function load() {
  const { sites = {} } = await browser.storage.local.get("sites");
  const lines = Object.entries(sites)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, mode]) => `${domain}=${mode}`);
  textarea.value = lines.join("\n");
}

function parse(text) {
  const sites = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s*=\s*(light|dark|system)$/i);
    if (!m) {
      throw new Error(`Unrecognised line: "${rawLine}"`);
    }
    const [, domain, mode] = m;
    const key = domain.toLowerCase().replace(/^\.+/, "");
    if (mode.toLowerCase() === "system") continue; // no override
    sites[key] = mode.toLowerCase();
  }
  return sites;
}

async function save() {
  try {
    const sites = parse(textarea.value);
    await browser.storage.local.set({ sites });
    status.textContent = `Saved (${Object.keys(sites).length} domains).`;
    setTimeout(() => (status.textContent = ""), 3000);
  } catch (e) {
    status.style.color = "#b00020";
    status.textContent = e.message;
    setTimeout(() => (status.style.color = "#2a7d2a"), 3000);
  }
}

load();
saveButton.addEventListener("click", save);