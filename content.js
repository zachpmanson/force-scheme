// Force Color Scheme — content script
//
// Three mechanisms, applied when a domain is forced:
//
// 1. Media-query rewrite: rewrite the page's own stylesheets so the site's
//    built-in light or dark theme applies regardless of system scheme. Only
//    touches media rules that reference `prefers-color-scheme`; everything
//    else is left alone.
// 2. color-scheme override: inject `:root { color-scheme: … !important }`,
//    which flips the browser's default canvas/text/widget palette. This
//    covers "color-scheme-only" sites (like danluu.com) that ship no media
//    queries and rely on UA-default colours.
// 3. Theme-attribute neutralization: sites with a JS theme picker stamp an
//    attribute on <html> (data-theme, data-color-mode, …) and gate their
//    dark CSS behind it (e.g. `:root:not([data-theme="light"])`), which no
//    media-query rewrite can touch. Assert the attribute to match the forced
//    mode, delete the localStorage keys that drive it, and keep re-asserting
//    when the site re-stamps it.
//
// Strategy per forced mode (mechanisms 1 and 2):
//   force light:
//     - rules inside `(prefers-color-scheme: dark)`  -> never match (neutered)
//     - rules inside `(prefers-color-scheme: light)` -> made unconditional
//     - root color-scheme forced to `light`
//   force dark:
//     - rules inside `(prefers-color-scheme: light)` -> never match (neutered)
//     - rules inside `(prefers-color-scheme: dark)`  -> made unconditional
//     - root color-scheme forced to `dark`
//
// This works because the target sites use CSS-only dark mode: their light
// styles are the default and dark styles only exist inside a media block
// (or come from UA-default colours under the page's color-scheme). No
// re-styling happens anywhere.

"use strict";

const PCS = /\(\s*prefers-color-scheme\s*:\s*(dark|light|no-preference)\s*\)/i;

// Attributes some sites stamp on <html> to record the active theme. Their
// dark CSS is often gated behind one specific value (e.g. AMO's
// `:root:not([data-theme="light"])`), so replacing a light-ish value is what
// makes the site's own dark rules reachable again.
const THEME_ATTRS = [
  "data-theme",
  "data-theme-mode",
  "data-color-scheme",
  "data-color-mode", // GitHub
  "data-mode",
  "data-bs-theme", // Bootstrap 5.3
];

// Attribute values that unambiguously mean "explicitly light" / "explicitly dark".
const LIGHT_VALUES = new Set(["light", "light-mode", "light-theme", "auto", "system", "default"]);
const DARK_VALUES = new Set(["dark", "dark-mode", "dark-theme", "night", "oled", "dim"]);

// localStorage keys sites re-read on (re)load to re-stamp the attribute.
// Deleted while a domain is forced, so the site's stored picker choice can't
// win. Side effect: the forced site "forgets" its in-page theme picker
// choice for as long as it is forced — that is the point.
const THEME_STORAGE_KEYS = [
  "amo_theme", // addons.mozilla.org (verified from its bundle, export `wN`)
  "color-mode", // GitHub (data-color-mode is its attr)
  "theme",
  "color-theme",
  "color-scheme",
  "colorScheme",
  "themeColor",
  "dark-mode",
  "darkmode",
  "preferredTheme",
];

// Diagnostics summary, printed once per page load (see end of main()).
const DIAG = { flipped: [], storageCleared: [], toAll: 0, neutered: 0, sheets: 0 };

let currentWanted = null; // "light" | "dark" | null (system behaviour)
let observer = null;

main();

async function main() {
  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }

  const stored = await browser.storage.local.get("sites");
  const mode = matchMode(stored.sites || {}, location.hostname);
  currentWanted = mode === "light" || mode === "dark" ? mode : null;
  if (!currentWanted) return;

  injectRootColorScheme(currentWanted);
  applyThemeAttributes(currentWanted);
  processAll();
  console.log(
    `[force-scheme] v${browser.runtime.getManifest().version}: forcing ${currentWanted} on ${location.hostname}; ` +
      `attr flips: ${DIAG.flipped.join(", ") || "none"}; ` +
      `cleared storage: ${DIAG.storageCleared.join(", ") || "none"}; ` +
      `media rules: ${DIAG.toAll}→unconditional, ${DIAG.neutered}→neutered`
  );
}

// --- settings lookup -------------------------------------------------------

// `example.com` covers the exact host and any subdomains (www.example.com, …).
function matchMode(sites, host) {
  if (!host) return null;
  if (sites[host]) return sites[host];
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join(".");
    if (sites[domain]) return sites[domain];
  }
  return null;
}

// --- color-scheme override -------------------------------------------------

// Sites like danluu.com ship no media queries at all — they declare
// `color-scheme: light dark` (meta tag or CSS) and rely on the browser's
// default palette for both schemes. Overriding the root colour-scheme is
// what actually flips those defaults. Author !important always beats the
// UA-origin meta tag and normal author declarations.
function injectRootColorScheme(wanted) {
  const style = document.createElement("style");
  style.textContent = `:root { color-scheme: ${wanted} !important; }`;
  style.dataset.forceScheme = "true";
  document.documentElement.appendChild(style); // valid at document_start
}

// --- theme-attribute neutralization ----------------------------------------

function applyThemeAttributes(wanted) {
  const el = document.documentElement;

  const assert = () => {
    for (const name of THEME_ATTRS) {
      const value = el.getAttribute(name);
      if (value === null || value === "") {
        // No picker state yet: activate the forced scheme so attribute-gated
        // sites (GitHub, Bootstrap, docs themes) follow it too.
        el.setAttribute(name, wanted);
        continue;
      }
      const lower = value.trim().toLowerCase();
      if (wanted === "dark" && LIGHT_VALUES.has(lower)) {
        el.setAttribute(name, "dark");
        DIAG.flipped.push(`${name}:"${value}"→"dark"`);
        console.log(`[force-scheme] flipped ${name}="${value}" → "dark" (${location.hostname})`);
      } else if (wanted === "light" && DARK_VALUES.has(lower)) {
        el.setAttribute(name, "light");
        DIAG.flipped.push(`${name}:"${value}"→"light"`);
        console.log(`[force-scheme] flipped ${name}="${value}" → "light" (${location.hostname})`);
      }
      // Unrecognised values (brand themes like "purple") are left alone.
    }
    // Class-based theming (Tailwind / shadcn convention: <html class="dark">).
    if (wanted === "dark") el.classList.add("dark");
    else el.classList.remove("dark");
  };

  assert();
  clearThemeStorage();

  // Re-assert whenever the site's own script re-stamps the attribute
  // (SPA navigation, storage-driven re-init, OS-change listeners).
  // attributeFilter excludes "class", so our own mutations never re-trigger.
  new MutationObserver(assert).observe(el, {
    attributes: true,
    attributeFilter: THEME_ATTRS,
  });
}

function clearThemeStorage() {
  for (const key of THEME_STORAGE_KEYS) {
    try {
      if (localStorage.getItem(key) !== null) DIAG.storageCleared.push(key);
      localStorage.removeItem(key);
    } catch (e) {
      // No localStorage (about:, sandboxed frames, data: URLs).
    }
  }
}

// --- stylesheet processing -------------------------------------------------

function processAll() {
  for (const sheet of Array.from(document.styleSheets)) {
    processSheet(sheet, currentWanted);
  }
}

function processSheet(sheet, wanted) {
  if (!sheet) return;
  if (sheet.media && /prefers-color-scheme/i.test(sheet.media.mediaText)) {
    handleMediaConditionalSheet(sheet, wanted);
    return;
  }
  walkRules(sheet, sheet.cssRules, wanted);
}

// A <link media="(prefers-color-scheme: …)"> or <style media="…"> sheet:
// decide via the sheet's own media list.
function handleMediaConditionalSheet(sheet, wanted) {
  const match = sheet.media.mediaText.match(PCS);
  if (!match) return;
  const scheme = match[1].toLowerCase();
  if (scheme === wanted) {
    sheet.disabled = false;
    try {
      sheet.media.mediaText = "all";
    } catch (e) {
      /* Firefox can't rewrite MediaList; rebuild the sheet instead */
    }
    if (/prefers-color-scheme/i.test(sheet.media.mediaText)) {
      rebuildSheetUnconditional(sheet);
    }
  } else if (scheme !== "no-preference") {
    sheet.disabled = true;
  }
}

// Firefox (Gecko) does not let you mutate a sheet's MediaList: assignments to
// `mediaText` are silently ignored. The reliable same-origin fallback is to
// clone the rules into a plain <style> with no media condition. Cross-origin
// sheets are unreadable and are simply left alone (they fall back to the
// page's other mechanisms).
function rebuildSheetUnconditional(sheet) {
  try {
    const parts = [];
    for (const rule of sheet.cssRules) parts.push(rule.cssText);
    if (!parts.length) return;
    const style = document.createElement("style");
    style.textContent = parts.join("\n");
    style.dataset.forceScheme = "true";
    const node = sheet.ownerNode;
    if (node && node.parentNode) {
      node.parentNode.insertBefore(style, node.nextSibling);
    } else {
      (document.head || document.documentElement).appendChild(style);
    }
  } catch (e) {
    // Cross-origin or otherwise unreadable sheet — give up.
  }
}

function rewriteRules(sheet, wanted) {
  let rules;
  try {
    rules = sheet.cssRules;
  } catch (e) {
    return; // cross-origin stylesheet — CSSOM is not readable
  }
  walkRules(sheet, rules, wanted);
}

// Rebuild a targeted @media rule so it applies regardless of the system
// scheme. Gecko (Firefox) silently ignores mutation of `conditionText` /
// `media.mediaText`, so the primary strategy is delete + reinsert with the
// condition text rewritten — this works on every engine (verified on Gecko
// 152 and Blink). The old direct-mutation path is kept as a fallback for
// engines where inserting is restricted.
function walkRules(owner, rules, wanted) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];

    if (rule.type === CSSRule.MEDIA_RULE) {
      const cond = rule.conditionText || (rule.media && rule.media.mediaText) || "";
      const match = cond.match(PCS);

      if (match) {
        const scheme = match[1].toLowerCase();

        // A block that lists BOTH schemes applies in every mode — leave it be.
        if (
          /prefers-color-scheme\s*:\s*dark/i.test(cond) &&
          /prefers-color-scheme\s*:\s*light/i.test(cond)
        ) {
          continue;
        }

        if (scheme === wanted) {
          // Desired scheme: strip the color-scheme part so the block
          // always applies, keeping any other conditions (max-width, …).
          const rest = cond
            .replace(PCS, "")
            .replace(/^\s*and\s+/i, "")
            .replace(/\s+and\s*$/i, "")
            .trim();
          if (replaceMediaRule(owner, rules, i, rest || "all")) DIAG.toAll++;
        } else if (scheme !== "no-preference") {
          // Opposite scheme: drop the rule entirely — never matches.
          if (replaceMediaRule(owner, rules, i, null)) DIAG.neutered++;
        }
      } else if (rule.cssRules) {
        // Nested media rule (e.g. inside @supports) — recurse.
        walkRules(rule, rule.cssRules, wanted);
      }
    } else if (rule.type === CSSRule.SUPPORTS_RULE && rule.cssRules) {
      walkRules(rule, rule.cssRules, wanted);
    }
  }
}

// newCond === null means "never match": delete the rule outright.
// Returns true when the rule ended up rewritten/deleted.
function replaceMediaRule(owner, rules, index, newCond) {
  const rule = rules[index];
  try {
    const css = rule.cssText;
    if (newCond === null) {
      owner.deleteRule(index);
      return true;
    }
    const replaced = css.replace(/@media[^{]*/, `@media ${newCond}`);
    owner.deleteRule(index);
    try {
      owner.insertRule(replaced, index);
    } catch (e) {
      // Rule deleted; leaving it out is equivalent to "never match" for the
      // desired-scheme case only if the block was the site's only dark
      // source — rare; accept the deletion rather than half-applying.
    }
    return true;
  } catch (e) {
    // Fallback for engines where delete/insert are restricted: direct mutation.
    try {
      rule.conditionText = newCond === null ? "not all" : newCond;
    } catch (e2) {
      try {
        rule.media.mediaText = newCond === null ? "not all" : newCond;
      } catch (e3) {
        return false;
      }
    }
    return false;
  }
}

// --- dynamically added styles (SPAs, lazy-loaded CSS) -----------------------

function startObserver() {
  observer = new MutationObserver((mutations) => {
    if (!currentWanted) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches && node.matches('style,link[rel="stylesheet"]')) {
          handleAddedStyleElement(node);
        }
        if (node.querySelectorAll) {
          node
            .querySelectorAll('style,link[rel="stylesheet"]')
            .forEach(handleAddedStyleElement);
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function handleAddedStyleElement(el) {
  if (el.sheet) {
    processSheet(el.sheet, currentWanted);
  }
  if (el.tagName === "LINK") {
    // Rules may not be populated until the stylesheet finishes loading.
    el.addEventListener("load", () => {
      if (el.sheet) processSheet(el.sheet, currentWanted);
    });
  }
}