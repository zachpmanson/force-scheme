// Force Color Scheme — background: toolbar 3-state toggle (unset / light / dark)
//
// Clicking the toolbar icon cycles the current domain:
//   unset (follow system) -> force light -> force dark -> unset (removed)
// The tab is reloaded so the new scheme applies immediately.
"use strict";

const MODE_META = {
  light: { badge: "L", label: "force light", bg: "#b0b7bd", fg: "#1a1a1a" },
  dark: { badge: "D", label: "force dark", bg: "#333333", fg: "#ffffff" },
};
// Click cycle: unset -> light -> dark -> unset
const NEXT = { light: "dark", dark: "unset" };

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function loadSites() {
  const { sites = {} } = await browser.storage.local.get("sites");
  return sites;
}

function stateLabel(mode, host) {
  const meta =
    mode === "light" || mode === "dark" ? MODE_META[mode].label : "follow system";
  const next =
    mode === "light" ? "force dark" : mode === "dark" ? "unset (follow system)" : "force light";
  return `Force Color Scheme — ${host}: ${meta} · click: ${next}`;
}

async function refreshBar(tab) {
  const host = hostOf(tab.url || "");
  const badge = browser.browserAction.setBadgeText;
  if (!host) {
    badge({ text: "", tabId: tab.id }).catch(() => {});
    browser.browserAction
      .setTitle({ title: "Force Color Scheme — only works on web pages", tabId: tab.id })
      .catch(() => {});
    return;
  }
  const sites = await loadSites();
  const mode = sites[host];
  if (mode === "light" || mode === "dark") {
    const meta = MODE_META[mode];
    browser.browserAction.setBadgeText({ text: meta.badge, tabId: tab.id }).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({ color: meta.bg, tabId: tab.id }).catch(() => {});
    browser.browserAction.setBadgeTextColor({ color: meta.fg, tabId: tab.id }).catch(() => {});
  } else {
    browser.browserAction.setBadgeText({ text: "", tabId: tab.id }).catch(() => {});
  }
  browser.browserAction.setTitle({ title: stateLabel(mode, host), tabId: tab.id }).catch(() => {});
}

browser.browserAction.onClicked.addListener(async (tab) => {
  const host = hostOf(tab.url || "");
  if (!host) {
    browser.browserAction
      .setTitle({ title: "Force Color Scheme — only works on web pages", tabId: tab.id })
      .catch(() => {});
    return;
  }
  const sites = await loadSites();
  const cur = sites[host];
  const next = NEXT[cur] || "light"; // unset -> light
  if (next === "unset") delete sites[host];
  else sites[host] = next;
  await browser.storage.local.set({ sites });
  await refreshBar(tab);
  browser.tabs.reload(tab.id);
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs
    .get(tabId)
    .then(refreshBar)
    .catch(() => {});
});

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") refreshBar(tab).catch(() => {});
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.sites) return;
  browser.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => tab && refreshBar(tab))
    .catch(() => {});
});

// Badge state on startup / first load
browser.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => tab && refreshBar(tab))
  .catch(() => {});