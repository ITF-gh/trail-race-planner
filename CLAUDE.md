# Prep my race (trail-race-planner): notes for AI coding sessions

Keep context small: open only the files a task needs, and search (grep) before reading whole files.

## Do not read whole
- `src/i18n/fr.json` (200 KB French dictionary): grep the English text, edit that entry only.
- `dist/` (build output), `src/ui/photos/`, `src/site/guide/`, `src/site/icons/`, `src/vendor/` (Leaflet).
- `supabase/functions/_shared/core/`: a generated copy of `src/core` (not in git). Edit `src/core`.
- `src/ui/css/` (160 KB in 11 files, joined in name order into dist/style.css): grep the class name, read only around it.

## Commands
- `npm test` (node:test, also refreshes the server copy of src/core), `npm run build` -> `dist/`, `npm run dev`.
- Zero dependencies. Push to `main` = tests + build + deploy to GitHub Pages.

## Build rules (scripts/build.js bundles by hand; it fails loudly if broken)
- One `import { ... } from "./x.js";` per line, never `as`, no top-level name declared in two files.
- Never put a comment inside a template literal (it would show on the page).
- The live build strips comments (scripts/strip.js), so comments cost nothing on the site.
- Comments stay short (Boss, 2026-11-02): one line for a file, a function or a tricky step; no teaching essays.

## Map
- `src/core/` engine, no DOM: track (GPX), terrain (climbs), effort (learn a runner), model (time prediction),
  plan (race plan), keyzones, script (race story), review + insights (Rewind my run), preprun (Prep my run),
  garmin (watch course), aiprep / airun / aichecks (AI calls), history / profile / saved / snapshot (account data).
- `src/ui/` browser: main (entry, files, modes, save), appstate (state, $, esc, store), pieces (tiles, profile,
  tables), route (01 engine, 02 route), race (03 plan, 04 race, 05 coach, nav), replay (race-day cockpit), review (Rewind my run),
  preprun, insights (Deep dive), account + acparts / profile / cloud (menu, window, Supabase), print (A4), map, watch, i18n.
- `src/site/` static pages (guide, about, privacy, changelog) built by `scripts/site-pages.js`.
- `supabase/` SQL migrations and Edge Functions (ai-analyse, delete-account, claim-cairns = edelweiss).

## Project rules
- Every new UI text needs a French entry in `src/i18n/fr.json` ("run", never "sortie").
- Before a change that goes live, create a branch `restore/vX.Y-before-<topic>` from `main`.
