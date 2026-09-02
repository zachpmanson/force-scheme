# Force Color Scheme

Per-domain override of `prefers-color-scheme` for Firefox. Lets you keep system
dark mode on but force specific sites to use their **own built-in** light or
dark theme — no re-styling, no injected CSS (except one `:root` rule, see
below). It only works for sites whose theming is CSS-only (dark styles live
inside `@media (prefers-color-scheme: …)` blocks **or** behind a theme
attribute on `<html>`), which is exactly the case where the DevTools override
is annoying to do by hand.

## Toolbar toggle (3-state)

The toolbar icon (half sun / half moon) cycles the **current domain**:

| Click state | Effect | Badge |
|-------------|--------|-------|
| unset       | follows system (no override) | *(none)* |
| off         | force **light**              | `L` |
| on          | force **dark**               | `D` |

Clicking again after `D` removes the domain from the list (back to system).
The tab reloads automatically so the change applies immediately. Hover the
icon to see the current state and what the next click does.

## What it does

Three mechanisms, applied for each domain in your list:

1. **Media-query rewrite** — rewrites the page's own stylesheets so its
   built-in theme applies regardless of the system scheme:

   | Forced mode   | `(prefers-color-scheme: dark)` blocks | `(prefers-color-scheme: light)` blocks |
   |---------------|---------------------------------------|-----------------------------------------|
   | `light`       | neutered (never match)                | made unconditional                       |
   | `dark`        | made unconditional                    | neutered (never match)                   |

   Other media conditions (width, height, …) inside those blocks are preserved.
   Blocks that list **both** schemes (a common Firefox-compat pattern) are left
   alone — they already apply in every mode.

2. **`color-scheme` override** — injects `:root { color-scheme: … !important }`
   on forced domains. This flips sites that declare `color-scheme: light dark`
   but ship **no media queries** and rely on the browser's default
   canvas/text palette — exactly danluu.com's approach.

3. **Theme-attribute neutralization** — sites with a JS theme picker stamp an
   attribute on `<html>` (e.g. `data-theme="light"`; AMO's dark CSS is gated
   behind `:root:not([data-theme="light"])`) that no media-query rewrite can
   touch. For forced domains this asserts the known theme attributes
   (`data-theme`, `data-theme-mode`, `data-color-scheme`, `data-color-mode`,
   `data-mode`, `data-bs-theme`) to match the forced mode, adds/removes the
   `dark` class (Tailwind/shadcn convention), and deletes the common
   localStorage keys sites re-read to re-stamp the attribute
   (`theme`, `color-theme`, `color-scheme`, …). A MutationObserver re-asserts
   if the site's own script re-stamps it later (SPA navigation, OS-change
   listeners).

   Caveat: while a domain is forced, that site *forgets* its in-page theme
   picker choice (its localStorage key is gone). That is the point — the
   toolbar state wins.

   Sites in this class: addons.mozilla.org is the canonical example, and the
   reason this mechanism exists.

Also handles `<link media="(prefers-color-scheme: …)">` stylesheets, and watches
for styles injected later by SPAs (MutationObserver).

## Install (personal use)

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**
2. Pick `manifest.json` in this folder
3. Open the extension's options (right-click the puzzle icon / `about:addons` →
   … → Preferences), or visit the options page from `about:addons`

## Config format (options page)

```
example.com=light      # force light even though your system is dark
news.example.net=dark  # force dark even though your system is light
# comment lines and blank lines are ignored
```

`example.com` also covers `www.example.com` and any subdomain. `system` (or
removing the line, or the toolbar toggle cycling back to unset) restores normal
behaviour — the site follows your system setting.

Changes apply on the next page load.

## Known limitations

- **Cross-origin stylesheets** (e.g. dark CSS served from a CDN) can't be
  rewritten — Firefox blocks CSSOM access to them. Same-origin CSS and inline
  `<style>` always work, which covers most sites.
- If a site's light theme is implemented as a global over-ride of CSS variables
  rather than defaults, neutering the dark block won't restore it (there'd be
  no light fallback). Rare; would need a small per-domain rule instead.
- Theme-attribute neutralization only knows common attribute names and values;
  a site using an exotic attribute (or a custom class) for its picker will
  still beat the force. The storage-key list is similarly a best-effort
  denylist.
- `privacy.resistFingerprinting: true` overrides the reported color scheme and
  breaks the effect (same caveat as the "Toggle dark mode" addon).

## Development

No build step. Edit, reload via `about:debugging`, done.

```bash
node --check content.js && node --check options.js
```