# Analects Reader

A small offline web app for reading the Analects and modern Chinese
meaning-first, and for walking the road to the first 3,000 characters. Reading
only: pinyin is shown small inside cards and never tested; there is no sound.

Plain HTML, CSS and JavaScript (`index.html`, `app.js`, `style.css`, `sw.js`).
No build step, no frameworks, no external requests of any kind.

## Five sections

A tab bar at the bottom (each tab a small seal: 读 路 词 法 我):

- **Read.** The two shelves, **Classical | Modern**. The text being read is
  open: its title, chapters read, a Continue button at the first unread
  chapter, yesterday's chapters to re-read cold, and the chapter grid. The other
  texts on the shelf sit below as single rows with their own Continue. Modern
  texts also show how much of their running characters he has marked known on
  the Path. A chapter opens full screen (no tab bar): the Chinese first, every
  character or word tappable, the typed attempt box, then **Show key**, then
  ✓ / ✗ and Next chapter, all in the bar under the thumb. The key links the
  classical chapter and its modern rendering both ways.
- **Path.** The 3,000 characters in 30 stages of 100. Home: the count marked
  known, the stage he is on, "what this unlocks" for each text, and the 30
  stages with a ring each. A stage page shows its families as sections, each
  character a tile (keyword under it; **Hide keywords** to test yourself), the
  drill (flip through one at a time: glyph, then keyword, parts, story; ✓ marks
  it known, ✗ sends it round again at the end; "only the ones I don't know"),
  and the stage's real sentences (Chinese first, English on a tap). A stage not
  written yet lists its characters and, when present, its sentences.
- **Words.** Every word of the modern texts, searchable by meaning, word or
  toneless pinyin; all or grammar words only; in the order met or commonest
  first.
- **Grammar.** The patterns of modern written Chinese, each with its frame,
  what it does, its counterpart in the Analects, and real example sentences.
  Below them, the grammar words from his texts.
- **Me.** Characters known with a per-stage strip, chapters read per shelf,
  lookups, the **Report** (to paste into the weekly chat), **Find**, the
  reading text size, "Mark the characters I have Analects cards for as known",
  Erase, and the build.

The card sheet rises from the bottom for any tapped character or word. In
modern content a single character opens its Path card (keyword, parts, story,
words, the Analects card it matches, Pleco, and **I know this**); a modern word
opens its word card, which lists its characters on the Path; a character of the
Analects opens its Analects card. Cards opened from a card have a Back arrow.
Pull the sheet down by its grip, tap outside it, or press Escape to close it.

## Updating the content

`data/` and `version.json` are generated. From the parent project run:

    python3 tools/build_site.py

It rewrites `data/` (including the Path: `path.json`, `path-index.json`,
`path-NN.json`, `patterns.json`), `version.json` and the
`const VERSION = "...";` line in `sw.js`. That line changing is what makes
installed copies offer "Update ready — tap to reload". Do not edit `data/` by
hand. The app works without the Path and pattern files (older data): those
sections then say so instead of failing.

The service worker precaches the shell files (`index.html`, `app.js`,
`style.css`, `manifest.webmanifest`, the icons, `version.json`), the data named
in its `SHELL` list, every book in `books.json`, and, when present, the Path
files and one stage file per stage in `path.json`.

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

Reading marks, looked-up characters, typed attempts and the characters marked
known are stored only in this phone's browser storage (localStorage, key
`analects-reader.v1`; its shape is documented at the top of `app.js`). They are
not synced or backed up. Deleting the home-screen app, clearing Safari/Chrome
website data, or a long spell without opening the app (iOS may clear storage
for unused sites) erases them. Copy the report to keep a record.
