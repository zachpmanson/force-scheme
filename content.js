// Force Color Scheme — content script
//
// Two mechanisms, applied when a domain is forced:
//
// 1. Media-query rewrite: rewrite the page's own stylesheets so the site's
//    built-in light or dark theme applies regardless of system scheme. Only
//    touches media rules that reference `prefers-color-scheme`; everything
//    else is left alone.
// 2. color-scheme override: inject `:root { color-scheme: … !important }`,
//    which flips the browser's default canvas/text/widget palette. This
//    covers "color-scheme-only" sites (like danluu.com) that ship no media
//    queries and rely on UA-default colours.
//
// Strategy per forced mode (both mechanisms):
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
  processAll();
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
  rewriteRules(sheet, wanted);
}

// A <link media="(prefers-color-scheme: …)"> or <style media="…"> sheet:
// decide via the sheet's own media list.
function handleMediaConditionalSheet(sheet, wanted) {
  const match = sheet.media.mediaText.match(PCS);
  if (!match) return;
  const scheme = match[1].toLowerCase();
  if (scheme === wanted) {
    sheet.media.mediaText = "all";
    sheet.disabled = false;
  } else if (scheme !== "no-preference") {
    sheet.disabled = true;
  }
}

function rewriteRules(sheet, wanted) {
  let rules;
  try {
    rules = sheet.cssRules;
  } catch (e) {
    return; // cross-origin stylesheet — CSSOM is not readable
  }
  walkRules(rules, wanted);
}

function walkRules(rules, wanted) {
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
          const newCond = rest || "all";
          try {
            rule.conditionText = newCond;
          } catch (e) {
            try {
              rule.media.mediaText = newCond;
            } catch (e2) {
              /* leave as-is */
            }
          }
        } else if (scheme !== "no-preference") {
          // Opposite scheme: neuter so it can never match.
          try {
            rule.conditionText = "not all";
          } catch (e) {
            try {
              rule.media.mediaText = "not all";
            } catch (e2) {
              try {
                rules.deleteRule(i);
              } catch (e3) {
                /* give up */
              }
            }
          }
        }
      } else if (rule.cssRules) {
        // Nested media rule (e.g. inside @supports) — recurse.
        walkRules(rule.cssRules, wanted);
      }
    } else if (rule.type === CSSRule.SUPPORTS_RULE && rule.cssRules) {
      walkRules(rule.cssRules, wanted);
    }
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