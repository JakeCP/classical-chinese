# Analects Reader

A small offline web app for reading the Analects meaning-first, one chapter at a
time: the Chinese first, the key only when asked, ✓/✗ marks, a character sheet
for any character, a search to find a character you cannot type, and a text
report to paste into the weekly chat with Claude.

Plain HTML, CSS and JavaScript. No build step, no external requests.

## Updating the content

`data/` and `version.json` are generated. From the parent project run:

    python3 tools/build_site.py

It rewrites `data/`, `version.json` and the `const VERSION = "...";` line in
`sw.js`. That line changing is what makes installed copies offer
"Update ready — tap to reload". Do not edit `data/` by hand.

## Publishing (GitHub Pages)

1. Push the contents of this folder (not the folder itself) to the root of a
   GitHub repository, branch `main`.
2. Repository Settings -> Pages -> Build and deployment: "Deploy from a branch",
   branch `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`. All paths are
   relative, so the subpath is fine. `.nojekyll` stops GitHub from processing it.

## Installing on a phone

- iPhone: open the URL in Safari -> Share -> Add to Home Screen.
- Android: open the URL in Chrome -> menu -> Install app (or Add to Home screen).

Open it once online; after that it works offline.

## Where your marks live

Reading marks, looked-up characters and typed attempts are stored only in this
phone's browser storage (localStorage). They are not synced or backed up.
Deleting the home-screen app, clearing Safari/Chrome website data, or a long
spell without opening the app (iOS may clear storage for unused sites) erases
them. Copy the report to keep a record.
