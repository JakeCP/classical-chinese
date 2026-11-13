// Analects Reader: one-file app. Plain DOM, hash routes, localStorage.
"use strict";

(() => {
  const STORE_KEY = "analects-reader.v1";
  const HAN = /\p{Script=Han}/u;
  const HAN_RUN = /(\p{Script=Han}+)/u;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const KINDS = { character: "character", grammar: "grammar word", component: "component", word: "word" };

  const app = document.getElementById("app");
  const sheet = document.getElementById("sheet");
  const sheetBody = document.getElementById("sheet-body");
  const backdrop = document.getElementById("sheet-backdrop");

  const data = { books: [], byId: {}, chars: {}, words: {}, alias: {}, mwords: {}, pairs: {}, version: null, index: null };
  let state = loadState();
  let storageOK = true;
  let lastRoute = "";
  let sheetOpener = null;
  let findQuery = "";
  let pendingAttempt = null; // unsaved textarea edit: a function that saves it
  // The current chapter visit. After a mark, the key and "Next chapter" stay for
  // the rest of the visit even if midnight passes.
  let visit = { key: "", keyOpen: false, mark: "", readT: 0, att: null };
  // Language tag of the screen being drawn: Traditional glyphs for the Analects,
  // Simplified for the modern shelf.
  let lang = "zh-Hant";

  // ---------- storage ----------

  function blankState() {
    return { v: 1, ch: {}, settings: { size: "M" }, book: null, cut: 0, shelf: "classical", mbook: null };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return normState(raw ? JSON.parse(raw) : null);
    } catch (e) { /* unreadable storage: start fresh, without saving */ }
    return blankState();
  }

  // Function declarations: loadState() runs before later const lines are reached.
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function str(x) { return typeof x === "string" ? x : ""; }

  // Coerce saved JSON to the expected shape, dropping whatever cannot be used.
  function normState(s) {
    const out = blankState();
    if (!isObj(s) || s.v !== 1) return out;
    if (isObj(s.settings) && ["S", "M", "L"].includes(s.settings.size)) out.settings.size = s.settings.size;
    if (typeof s.book === "string") out.book = s.book;
    if (s.shelf === "modern") out.shelf = "modern";
    if (typeof s.mbook === "string") out.mbook = s.mbook;
    if (Number.isFinite(s.cut)) out.cut = s.cut;
    if (isObj(s.ch)) {
      for (const [k, r] of Object.entries(s.ch)) if (isObj(r)) out.ch[k] = normRec(r);
    }
    return out;
  }

  function normRec(r) {
    const reads = (Array.isArray(r.reads) ? r.reads : [])
      .filter((x) => isObj(x) && DAY.test(str(x.d)) && (x.r === "ok" || x.r === "x"))
      .map((x) => {
        const read = { d: x.d, r: x.r, t: Number.isFinite(x.t) ? x.t : 0 };
        if (str(x.att)) read.att = x.att;
        return read;
      });
    const look = {};
    if (isObj(r.look)) {
      for (const [c, n] of Object.entries(r.look)) if (Number.isFinite(n) && n > 0) look[c] = Math.floor(n);
    }
    return { reads, look, att: str(r.att), attDay: DAY.test(str(r.attDay)) ? r.attDay : "", keyDay: str(r.keyDay) };
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      storageOK = true;
    } catch (e) {
      storageOK = false;
    }
    return storageOK;
  }

  // Per-chapter record: { reads: [{d, r, t, att?}], look: {char: count},
  // att: working attempt, attDay: the day it was typed, keyDay: day the key was shown }
  const blankRec = () => ({ reads: [], look: {}, att: "", attDay: "", keyDay: "" });
  function chRec(key, create) {
    let rec = state.ch[key];
    if (!rec && create) rec = state.ch[key] = blankRec();
    return rec || blankRec();
  }

  const chKey = (book, n) => book.id + ":" + n;
  const lastRead = (rec) => rec.reads[rec.reads.length - 1] || null;

  // ---------- dates (local, never UTC) ----------

  function today() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDay(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  const dayShort = (s) => parseDay(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const dayLong = (s) => parseDay(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const dayFull = (s) => parseDay(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  // ---------- DOM helpers (text only: data is never parsed as HTML) ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Wraps runs of Han in a lang tag so phones pick the right glyphs for the shelf.
  function zhRuns(text) {
    return String(text).split(HAN_RUN).filter(Boolean)
      .map((part) => HAN.test(part) ? h("span", { lang }, part) : part);
  }

  // Every Han character becomes its own tappable span; punctuation stays text.
  function tappable(text) {
    return [...text].map((c) => HAN.test(c)
      ? h("span", { class: "h", "data-c": c, role: "button", tabindex: "0" }, c)
      : h("span", { class: "p" }, c));
  }

  // Modern text arrives cut into words: each word is one tappable span.
  function tappableToks(toks) {
    return toks.map((t) => typeof t === "string"
      ? h("span", { class: "p" }, t)
      : h("span", { class: "h w", "data-c": t[1], "data-m": "1", role: "button", tabindex: "0" }, t[0]));
  }

  function render(...nodes) {
    app.replaceChildren(...nodes.filter(Boolean));
  }


  // ---------- data ----------

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ": " + res.status);
    return res.json();
  }

  async function loadData() {
    const list = await getJSON("data/books.json");
    const [books, chars, modern] = await Promise.all([
      Promise.all(list.books.map((b) => getJSON(b.file).then((full) => Object.assign({}, b, full)))),
      getJSON("data/chars.json"),
      getJSON("data/modern-words.json").catch(() => ({ words: {} })),
    ]);
    books.sort((a, b) => a.order - b.order);
    data.books = books;
    books.forEach((b) => { data.byId[b.id] = b; });
    data.chars = chars.chars || {};
    data.words = chars.words || {};
    data.mwords = modern.words || {};
    // A modern passage can name its classical twin; remember the way back too.
    for (const b of books) {
      for (const c of b.chapters) {
        if (c.pair && data.byId[c.pair.book]) data.pairs[c.pair.book + ":" + c.pair.n] = { book: b, n: c.n };
      }
    }
    for (const [c, e] of Object.entries(data.chars)) {
      for (const alt of [e.also || [], ...(e.more || []).map((m) => m.also || [])].flat()) {
        if (!data.chars[alt] && !data.alias[alt]) data.alias[alt] = c;
      }
    }
    getJSON("version.json").then((v) => { data.version = v; paintVersion(); }).catch(() => {});
  }

  function lookup(c) {
    if (data.chars[c]) return { head: c, e: data.chars[c] };
    if (data.words[c]) return { head: c, e: data.words[c], word: true };
    if (data.alias[c]) return { head: data.alias[c], e: data.chars[data.alias[c]] };
    return null;
  }

  // ---------- shelves: "classical" (the Analects) and "modern" ----------

  const shelfOf = (book) => (book && book.shelf) || "classical";
  const shelfBooks = (shelf) => data.books.filter((b) => shelfOf(b) === shelf);
  const langOf = (book) => shelfOf(book) === "modern" ? "zh-Hans" : "zh-Hant";
  const surfaceOf = (key) => (data.mwords[key] && data.mwords[key].s) || String(key).split("@")[0];

  function currentBook() {
    const shelf = state.shelf === "modern" && shelfBooks("modern").length ? "modern" : "classical";
    const list = shelfBooks(shelf);
    const saved = data.byId[shelf === "modern" ? state.mbook : state.book];
    return (saved && shelfOf(saved) === shelf ? saved : list[0]) || data.books[0];
  }

  function setBook(book) {
    state.shelf = shelfOf(book);
    if (state.shelf === "modern") state.mbook = book.id; else state.book = book.id;
  }

  function bookStats(book) {
    let read = 0, x = 0;
    for (const c of book.chapters) {
      const last = lastRead(chRec(chKey(book, c.n)));
      if (last) { read++; if (last.r === "x") x++; }
    }
    return { read, x, total: book.chapters.length };
  }

  function firstUnread(book) {
    return book.chapters.find((c) => !chRec(chKey(book, c.n)).reads.length) || null;
  }

  // Next chapter across books, in reading order.
  function neighbour(book, idx, step) {
    const list = shelfBooks(shelfOf(book));
    const bi = list.indexOf(book);
    if (book.chapters[idx + step]) return { book, ch: book.chapters[idx + step] };
    const ob = list[bi + step];
    if (!ob) return null;
    return { book: ob, ch: step > 0 ? ob.chapters[0] : ob.chapters[ob.chapters.length - 1] };
  }

  const chHref = (book, n) => "#/c/" + encodeURIComponent(book.id) + "/" + encodeURIComponent(n);

  // ---------- routing ----------

  function route() {
    if (!data.books.length) return; // a hash change while the texts are still loading
    flushAttempt();
    const hash = location.hash || "#/";
    if (hash !== lastRoute) closeSheet(false);
    const same = hash === lastRoute;
    const y = window.scrollY;
    lastRoute = hash;
    try {
      const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
      const isChapter = parts[0] === "c" && data.byId[parts[1]];
      const key = isChapter ? parts[1] + ":" + parts[2] : "";
      if (visit.key !== key) visit = { key, keyOpen: false, mark: "", readT: 0, att: null };
      lang = langOf(isChapter ? data.byId[parts[1]] : currentBook());
      if (isChapter) renderChapter(data.byId[parts[1]], parts[2]);
      else if (parts[0] === "find") renderFind();
      else if (parts[0] === "report") renderReport();
      else renderHome();
    } catch (err) {
      // A malformed link or odd saved data must never strand him on a blank page.
      console.warn(err);
      visit = { key: "", keyOpen: false, mark: "", readT: 0, att: null };
      renderHome();
    }
    window.scrollTo(0, same ? y : 0);
  }

  // Re-render the current screen, keeping the scroll position.
  const refresh = () => route();

  function topBar(...kids) {
    return h("header", { class: "top" }, ...kids);
  }

  const homeLink = () => h("a", { class: "text-btn", href: "#/" }, "Home");

  function bar(...kids) {
    return h("nav", { class: "bar" }, h("div", { class: "bar-inner" }, ...kids));
  }

  // ---------- home ----------

  function renderHome() {
    const book = currentBook();
    const st = bookStats(book);
    const next = firstUnread(book);
    const t = today();

    const head = h("div", { class: "book-head" },
      h("span", { class: "seal", lang, "aria-hidden": "true" }, book.seal || "論"),
      h("div", { class: "grow" },
        shelfBooks(shelfOf(book)).length > 1 ? bookSwitcher(book) : bookTitle(book)));

    const unit = shelfOf(book) === "modern" ? "passages" : "chapters";
    const progress = h("p", { class: "progress" },
      `${st.read} of ${st.total} ${unit} read`,
      st.x ? h("span", { class: "x" }, `, ${st.x} ✗`) : null);

    const kids = [shelfSwitch(book), head, progress];
    if (!storageOK) kids.push(h("p", { class: "status" }, "This browser is not saving your marks."));

    const re = rereadDay(book, t);
    if (re) {
      kids.push(h("h2", { class: "section-label" }, "Re-read cold ", h("span", { class: "aside" }, "from " + dayLong(re.day))));
      kids.push(h("div", { class: "reread" }, re.chapters.map((c) => {
        const last = lastRead(chRec(chKey(book, c.n)));
        return h("a", { class: "pill" + (last && last.r === "x" ? " x" : ""), href: chHref(book, c.n) },
          c.n, last && last.r === "x" ? "✗" : null);
      })));
    }

    kids.push(h("h2", { class: "section-label" }, unit === "passages" ? "Passages" : "Chapters"));
    kids.push(h("div", { class: "grid" }, book.chapters.map((c) => chip(book, c, next))));
    kids.push(h("div", { class: "settings" }, h("span", null, "Reading text size"), sizeSetting()));
    kids.push(footer(book));

    let primary;
    if (next) {
      primary = h("a", { class: "btn primary", href: chHref(book, next.n) }, "Continue ", next.n);
    } else {
      const shelf = shelfBooks(shelfOf(book));
      const later = shelf.slice(shelf.indexOf(book) + 1).find(firstUnread);
      primary = later
        ? h("button", { class: "btn primary", type: "button", onclick: () => { setBook(later); save(); location.hash = chHref(later, firstUnread(later).n); } }, "Continue ", ...zhRuns(later.label))
        : h("button", { class: "btn primary", type: "button", disabled: true }, `All ${st.total} read`);
    }
    kids.push(bar(
      h("a", { class: "btn side", href: "#/find" }, "Find"),
      primary,
      h("a", { class: "btn side", href: "#/report" }, "Report")));
    render(...kids);
  }

  function bookTitle(book) {
    return h("h1", { class: "book-title" }, ...zhRuns(book.label));
  }

  function bookSwitcher(book) {
    const sel = h("select", { class: "book-select", "aria-label": "Book", onchange: (e) => { setBook(data.byId[e.target.value]); save(); refresh(); } },
      shelfBooks(shelfOf(book)).map((b) => h("option", { value: b.id, selected: b.id === book.id }, b.label)));
    return h("div", null, bookTitle(book), sel);
  }

  // Classical | Modern. Shown only once there is something on the modern shelf.
  function shelfSwitch(book) {
    if (!shelfBooks("modern").length) return null;
    const cur = shelfOf(book);
    return h("div", { class: "seg shelf", role: "group", "aria-label": "Shelf" },
      [["classical", "Classical"], ["modern", "Modern"]].map(([id, name]) => h("button", {
        type: "button",
        id: "shelf-" + id,
        "aria-pressed": String(id === cur),
        onclick: () => { state.shelf = id; save(); refresh(); },
      }, name)));
  }

  function chip(book, c, next) {
    const last = lastRead(chRec(chKey(book, c.n)));
    const cls = "chip" + (last ? (last.r === "x" ? " x" : " ok") : "") + (next && next.n === c.n ? " next" : "");
    const label = c.n + (last ? (last.r === "x" ? ", came out wrong" : ", got it") : ", not read");
    return h("a", { class: cls, href: chHref(book, c.n), "aria-label": label },
      c.n.split(".").pop(),
      last ? h("span", { class: "mark", "aria-hidden": "true" }, last.r === "x" ? "✗" : "✓") : null);
  }

  // The chapters read on the most recent reading day before today.
  function rereadDay(book, t) {
    let day = "";
    for (const c of book.chapters) {
      for (const r of chRec(chKey(book, c.n)).reads) if (r.d < t && r.d > day) day = r.d;
    }
    if (!day) return null;
    const chapters = book.chapters.filter((c) => chRec(chKey(book, c.n)).reads.some((r) => r.d === day));
    return { day, chapters };
  }

  function sizeSetting() {
    const cur = state.settings.size || "M";
    const names = { S: "Small", M: "Medium", L: "Large" };
    return h("div", { class: "seg", role: "group", "aria-label": "Reading text size" },
      ["S", "M", "L"].map((s, i) => h("button", {
        type: "button",
        "aria-pressed": String(s === cur),
        "aria-label": names[s] + " text",
        lang: "zh-Hant",
        style: `font-size:${0.85 + i * 0.2}rem`,
        onclick: () => { state.settings.size = s; save(); applySettings(); refresh(); },
      }, "文")));
  }

  function footer(book) {
    return h("footer", { class: "foot" },
      h("p", { id: "version" }, versionText()),
      h("p", null, "Translations are Claude's own: check against a published one."),
      book && book.credit ? h("p", { class: "credit" }, book.credit) : null);
  }

  function versionText() {
    const v = data.version;
    if (!v) return "Build unknown";
    const built = v.built ? new Date(v.built) : null;
    return "Build " + v.version + (built && !isNaN(built) ? ", " + built.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  }

  function paintVersion() {
    const el = document.getElementById("version");
    if (el) el.textContent = versionText();
  }

  // ---------- chapter ----------

  function renderChapter(book, n) {
    const idx = book.chapters.findIndex((c) => c.n === n);
    if (idx < 0) { location.replace("#/"); return; }
    if (currentBook() !== book) { setBook(book); save(); }
    const ch = book.chapters[idx];
    const key = chKey(book, ch.n);
    const rec = chRec(key);
    const keyShown = keyIsShown(key);
    const prev = neighbour(book, idx, -1);
    const next = neighbour(book, idx, 1);

    const kids = [
      topBar(
        homeLink(),
        h("h1", { class: "grow" },
          h("span", { class: "ch-num" }, ch.n),
          h("span", { class: "ch-pos" }, `${idx + 1} / ${book.chapters.length}`)),
        prev ? h("a", { class: "icon-btn", href: chHref(prev.book, prev.ch.n), "aria-label": "Previous chapter " + prev.ch.n }, "‹")
          : h("button", { class: "icon-btn", type: "button", disabled: true, "aria-label": "No previous chapter" }, "‹"),
        next ? h("a", { class: "icon-btn", href: chHref(next.book, next.ch.n), "aria-label": "Next chapter " + next.ch.n }, "›")
          : h("button", { class: "icon-btn", type: "button", disabled: true, "aria-label": "No next chapter" }, "›")),
      h("p", { class: "text" + (ch.toks ? " modern" : ""), lang, "data-ctx": key },
        ch.toks ? tappableToks(ch.toks) : tappable(ch.text)),
    ];

    if (ch.new && ch.new.length) {
      kids.push(h("h2", { class: "section-label" }, "New"));
      kids.push(h("div", { class: "chars" }, ch.new.map((c) => ch.toks
        ? h("button", { type: "button", class: "char-btn word", lang, "data-c": c, "data-m": "1", "data-ctx": key }, surfaceOf(c))
        : h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": c, "data-ctx": key }, c))));
    }
    if (ch.gloss && ch.gloss.length) {
      kids.push(h("h2", { class: "section-label" }, "Glossed"));
      kids.push(h("ul", { class: "gloss" }, ch.gloss.map((g) =>
        h("li", null,
          h("span", { class: "t", lang: "zh-Hant", "data-ctx": key }, tappable(g.t)),
          h("span", { class: "g" }, ...zhRuns(g.g || ""))))));
    }

    kids.push(attemptBox(key, rec));
    if (keyShown) kids.push(keyBlock(book, ch));
    kids.push(chapterBar(book, ch, key, rec, keyShown, next));
    render(...kids);
  }

  const keyIsShown = (key) => chRec(key).keyDay === today() || (visit.key === key && visit.keyOpen);

  // An attempt belongs to the day it was typed: on a later day the box starts empty.
  const todaysAttempt = (rec) => rec.attDay === today() ? rec.att : "";

  function attemptBox(key, rec) {
    const note = h("p", { class: "saved-note", "aria-live": "polite" });
    let timer = 0;
    const ta = h("textarea", {
      id: "attempt",
      rows: "4",
      placeholder: "Your English, typed or dictated",
      oninput: (e) => {
        clearTimeout(timer);
        const val = e.target.value;
        pendingAttempt = () => {
          clearTimeout(timer);
          pendingAttempt = null;
          const r = chRec(key, true);
          r.att = val;
          r.attDay = today();
          // The read this visit made always carries the visit's current attempt.
          if (visit.key === key) {
            visit.att = val;
            const read = visit.readT && r.reads.find((x) => x.t === visit.readT);
            if (read) setReadAttempt(read, val);
          }
          note.textContent = save() ? "Saved on this phone." : "Not saved: this browser blocks storage.";
        };
        timer = setTimeout(pendingAttempt, 400);
      },
      onblur: () => flushAttempt(),
    });
    // Within one visit the box keeps its text even across midnight; a new visit
    // only sees an attempt typed today.
    if (visit.key === key && visit.att === null) visit.att = todaysAttempt(rec);
    const att = visit.key === key ? visit.att : todaysAttempt(rec);
    ta.value = att;
    return h("details", { class: "attempt", open: att ? true : null },
      h("summary", null, "Type or dictate your attempt"), ta, note);
  }

  function setReadAttempt(read, text) {
    const t = String(text || "").trim();
    if (t) read.att = t; else delete read.att;
  }

  function flushAttempt() {
    if (pendingAttempt) pendingAttempt();
  }

  function keyBlock(book, ch) {
    const kids = [];
    if (ch.wfw && ch.wfw.length) kids.push(h("h2", { class: "section-label" }, "Word for word"), wfwBlock(ch.wfw));
    else if (ch.literal) kids.push(h("h2", { class: "section-label" }, "Word for word"), literalBlock(ch.literal));
    if (ch.translation) kids.push(h("h2", { class: "section-label" }, "Translation"), h("p", { class: "translation" }, ...zhRuns(ch.translation)));
    if (ch.note) kids.push(h("h2", { class: "section-label" }, "Note"), h("p", { class: "note" }, ...zhRuns(ch.note)));
    // The same chapter on the other shelf, offered only once the key is open.
    const twin = ch.pair ? { book: data.byId[ch.pair.book], n: ch.pair.n } : data.pairs[book.id + ":" + ch.n];
    if (twin && twin.book) {
      kids.push(h("p", { class: "pair" }, h("a", { id: "pair", href: chHref(twin.book, twin.n) },
        shelfOf(twin.book) === "modern" ? `${twin.n} in modern Chinese ›` : `${twin.n} in the classical text ›`)));
    }
    return h("section", { class: "key", id: "key", "aria-label": "Key" }, ...kids);
  }

  // Modern key: one paragraph per sentence, each word in ink with its English in grey.
  function wfwBlock(rows) {
    return h("div", { class: "literal" }, rows.filter((row) => row.length).map((row) =>
      h("p", null, row.map(([s, g]) => h("span", { class: "lit" },
        h("span", { class: "lz", lang }, s),
        g ? h("span", { class: "le" }, g) : null)))));
  }

  // "富與貴 wealth and rank · 是 these · 也. 不以其道 ..." becomes one paragraph per
  // sentence, each item set as Chinese in ink then its English in grey.
  function literalBlock(text) {
    const sentences = text.split(/\.\s+(?=\p{Script=Han})/u);
    return h("div", { class: "literal" }, sentences.map((sent) =>
      h("p", null, sent.split(/\s+·\s+/).map((item) => {
        const m = /^([\p{Script=Han}\s]*\p{Script=Han})\s*(.*)$/su.exec(item.trim());
        return h("span", { class: "lit" },
          m ? h("span", { class: "lz", lang: "zh-Hant" }, m[1]) : null,
          h("span", { class: "le" }, ...zhRuns(m ? m[2] : item.trim())));
      }))));
  }

  function chapterBar(book, ch, key, rec, keyShown, next) {
    if (!keyShown) {
      return bar(h("button", {
        type: "button", class: "btn primary", id: "show-key",
        onclick: () => {
          chRec(key, true).keyDay = today();
          visit.keyOpen = true;
          save();
          refresh();
          const el = document.getElementById("key");
          if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        },
      }, "Show key"));
    }
    const last = lastRead(rec);
    const markedToday = visit.key === key && visit.mark ? visit.mark : (last && last.d === today() ? last.r : "");
    const mark = (r) => () => { recordRead(key, r); refresh(); };
    const ok = h("button", { type: "button", class: "btn ok", id: "mark-ok", "aria-pressed": String(markedToday === "ok"), onclick: mark("ok") },
      markedToday ? "✓" : "✓ Got it");
    const x = h("button", { type: "button", class: "btn x", id: "mark-x", "aria-pressed": String(markedToday === "x"), onclick: mark("x") },
      markedToday ? "✗" : "✗ Came out wrong");
    if (markedToday) {
      ok.setAttribute("aria-label", "Got it");
      x.setAttribute("aria-label", "Came out wrong");
      ok.classList.add("side");
      x.classList.add("side");
      const go = next
        ? h("a", { class: "btn primary", id: "next-ch", href: chHref(next.book, next.ch.n) }, "Next chapter")
        : h("a", { class: "btn primary", id: "next-ch", href: "#/" }, "Home");
      return bar(ok, x, go);
    }
    return bar(ok, x);
  }

  // A second mark in the same visit or on the same day replaces the first: that is
  // how a mistake is fixed. The day's attempt is stored with the read.
  function recordRead(key, r) {
    flushAttempt();
    const rec = chRec(key, true);
    const d = today();
    const last = lastRead(rec);
    let read = visit.key === key && visit.readT ? rec.reads.find((x) => x.t === visit.readT) : null;
    if (!read && last && last.d === d) read = last;
    if (!read) { read = { d, r, t: 0 }; rec.reads.push(read); }
    read.r = r;
    read.t = Date.now();
    const att = visit.key === key && visit.att !== null ? visit.att : (rec.attDay === read.d ? rec.att : "");
    setReadAttempt(read, att);
    visit = { key, keyOpen: true, mark: r, readT: read.t, att: visit.key === key ? visit.att : null };
    save();
  }

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- character sheet ----------

  // ctx is the chapter key ("book-04:4.5") when opened from a chapter, else null.
  // modern: c is a key of the modern lexicon (a whole word), not a single character.
  function openSheet(c, ctx, tapped, modern) {
    const ctxInfo = ctx ? chapterFromKey(ctx) : null;
    if (ctxInfo && !keyIsShown(ctx)) {
      const rec = chRec(ctx, true);
      const shown = modern ? surfaceOf(c) : c;
      rec.look[shown] = (rec.look[shown] || 0) + 1;
      save();
    }
    sheetOpener = document.activeElement;
    sheetBody.replaceChildren(...(modern ? modernSheet(c, ctxInfo) : sheetContent(c, ctxInfo)));
    sheetBody.scrollTop = 0;
    sheet.hidden = false;
    backdrop.hidden = false;
    document.getElementById("sheet-close").focus({ preventScroll: true });
    if (tapped) keepAboveSheet(tapped);
  }

  // Scroll so the tapped character sits above the sheet. The extra page padding
  // (html.sheet-open) makes room to scroll near the end of a short chapter.
  function keepAboveSheet(el) {
    document.documentElement.classList.add("sheet-open");
    const r = el.getBoundingClientRect();
    const top = window.innerHeight - sheet.offsetHeight; // final position, ignoring the rise animation
    const room = Math.min(16, top / 4);
    if (r.bottom > top - room) window.scrollBy(0, r.bottom - top + room + 8);
    else if (r.top < 0) window.scrollBy(0, r.top - 16);
  }

  function closeSheet(restoreFocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    document.documentElement.classList.remove("sheet-open");
    document.querySelectorAll(".h.on").forEach((x) => x.classList.remove("on"));
    if (restoreFocus && sheetOpener && document.contains(sheetOpener)) sheetOpener.focus({ preventScroll: true });
    sheetOpener = null;
  }

  function chapterFromKey(key) {
    const i = key.lastIndexOf(":");
    const book = data.byId[key.slice(0, i)];
    const ch = book && book.chapters.find((c) => c.n === key.slice(i + 1));
    return ch ? { book, ch } : null;
  }

  function sheetContent(c, ctx) {
    const found = lookup(c);
    const e = found && found.e;
    const kids = [h("div", { class: "sheet-head" },
      h("span", { class: "sheet-char", lang: "zh-Hant", id: "sheet-head" }, c),
      h("div", null,
        e && e.kw ? h("p", { class: "sheet-kw" }, e.kw) : null,
        e && e.py ? h("p", { class: "sheet-py" }, e.py) : null,
        e ? h("p", { class: "sheet-kind" }, kindLabel(e, found), found.head !== c ? h("span", { lang: "zh-Hant" }, ", under " + found.head) : null) : null,
        h("a", { class: "pleco", href: "plecoapi://x-callback-url/s?q=" + encodeURIComponent(c) }, "Open in Pleco")))];

    if (e) {
      kids.push(...entryFields(e));
      for (const m of e.more || []) {
        kids.push(h("div", { class: "more" },
          h("p", { class: "more-head" }, "Also a " + (KINDS[m.k] || m.k) + ": " + (m.kw || ""), m.py ? h("span", { class: "py" }, m.py) : null),
          ...entryFields(m)));
      }
    } else {
      kids.push(h("p", { class: "none" }, "No card yet"));
    }

    if (ctx) kids.push(...inChapter(c, ctx));
    if (e && e.n > 0) kids.push(h("p", { class: "count" }, `×${e.n} in the Analects`));
    if (e && e.src) kids.push(h("p", { class: "src" }, ...zhRuns("Card: " + e.src)));

    const where = appearances(c);
    if (where.length) {
      kids.push(h("h3", { class: "section-label" }, `Appears in ${where.length} ${where.length === 1 ? "chapter" : "chapters"}`));
      kids.push(h("div", { class: "appears" }, where.map(({ book, ch }) =>
        h("a", {
          class: "pill" + (ctx && ctx.ch === ch ? " here" : ""),
          href: chHref(book, ch.n),
          onclick: () => closeSheet(false),
        }, ch.n))));
    }

    return kids;
  }

  // The sheet for a modern word: meaning, parts, its traditional form, the Analects
  // cards its characters already have, and where else it turns up.
  function modernSheet(key, ctx) {
    const e = data.mwords[key];
    const s = surfaceOf(key);
    const kids = [h("div", { class: "sheet-head" },
      h("span", { class: "sheet-char" + ([...s].length > 1 ? " word" : ""), lang: "zh-Hans", id: "sheet-head" }, s),
      h("div", null,
        e ? h("p", { class: "sheet-kw" }, e.g) : null,
        e && e.py ? h("p", { class: "sheet-py" }, e.py) : null,
        e ? h("p", { class: "sheet-kind" }, (e.k === "grammar" ? "grammar word" : "word") + (e.card ? "" : ", no card")) : null,
        h("a", { class: "pleco", href: "plecoapi://x-callback-url/s?q=" + encodeURIComponent(s) }, "Open in Pleco")))];
    if (!e) {
      kids.push(h("p", { class: "none" }, "No entry yet"));
      return kids;
    }
    const field = (label, text) => {
      if (text) kids.push(h("h3", { class: "section-label" }, label), h("p", { class: "field" }, ...zhRuns(text)));
    };
    if (ctx && ctx.ch.wfw) {
      const here = [];
      for (const row of ctx.ch.wfw) for (const [w, g] of row) if (w === s && g && !here.includes(g)) here.push(g);
      if (here.length && here.join("; ") !== e.g.split(";")[0].trim()) field("In this passage", here.join("; "));
    }
    field("Parts", e.parts);
    if (e.trad) kids.push(h("h3", { class: "section-label" }, "Traditional"), h("p", { class: "field" }, h("span", { lang: "zh-Hant" }, e.trad)));
    if (e.known && e.known.length) {
      kids.push(h("h3", { class: "section-label" }, "Your Analects cards"));
      kids.push(h("p", { class: "known" }, e.known.flatMap(([c, kw]) => [
        h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": c }, c),
        h("span", null, kw)])));
    }
    field(e.k === "grammar" ? "Jobs" : "Note", e.note);
    if (e.n > 0) kids.push(h("p", { class: "count" }, `×${e.n} in the modern texts`));
    if (e.src) kids.push(h("p", { class: "src" }, ...zhRuns("First met: " + e.src)));
    const where = [];
    for (const book of shelfBooks("modern")) {
      for (const ch of book.chapters) if ((ch.toks || []).some((t) => typeof t !== "string" && t[1] === key)) where.push({ book, ch });
    }
    if (where.length) {
      kids.push(h("h3", { class: "section-label" }, `Appears in ${where.length} ${where.length === 1 ? "passage" : "passages"}`));
      kids.push(h("div", { class: "appears" }, where.slice(0, 60).map(({ book, ch }) =>
        h("a", {
          class: "pill" + (ctx && ctx.ch === ch ? " here" : ""),
          href: chHref(book, ch.n),
          onclick: () => closeSheet(false),
        }, ch.n))));
    }
    return kids;
  }

  function kindLabel(e, found) {
    if (found.word) return "word";
    return KINDS[e.k] || e.k || "";
  }

  function entryFields(e) {
    const out = [];
    const field = (label, text, cls) => {
      if (text) out.push(h("h3", { class: "section-label" }, label), h("p", { class: "field " + (cls || "") }, ...zhRuns(text)));
    };
    if (e.also && e.also.length) field("Also written", e.also.join(" "));
    if (e.k === "character") {
      field("Parts", e.parts);
      field("Story", e.story, "story");
      field("On the street", e.forms);
      field("Note", e.note);
    } else if (e.k === "grammar") {
      field("Jobs", e.jobs);
    } else {
      field("Note", e.note);
    }
    return out;
  }

  // Gloss items and multi-character words in this chapter that contain c.
  function inChapter(c, { ch }) {
    const out = [];
    for (const g of ch.gloss || []) {
      if (!g.t.includes(c)) continue;
      out.push(h("div", { class: "in-ch" },
        h("span", { class: "t", lang: "zh-Hant" }, g.t),
        g.py ? h("span", { class: "py" }, g.py) : null,
        h("p", null, ...zhRuns(g.g || ""))));
    }
    for (const [w, e] of Object.entries(data.words)) {
      if (w === c || !w.includes(c) || !ch.text.includes(w)) continue;
      out.push(h("div", { class: "in-ch" },
        h("span", { class: "t", lang: "zh-Hant" }, w),
        e.py ? h("span", { class: "py" }, e.py) : null,
        h("p", null, e.kw || ""),
        e.jobs ? h("p", null, ...zhRuns(e.jobs)) : null));
    }
    if (out.length) out.unshift(h("h3", { class: "section-label" }, "In this chapter"));
    return out;
  }

  function appearances(c) {
    const out = [];
    for (const book of data.books) for (const ch of book.chapters) if (ch.text.includes(c)) out.push({ book, ch });
    return out;
  }

  // One listener for every tappable character on every screen.
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-c]");
    if (!el) return;
    if (el.classList.contains("h")) el.classList.add("on");
    const ctxEl = el.closest("[data-ctx]");
    openSheet(el.dataset.c, ctxEl ? ctxEl.dataset.ctx : null, ctxEl ? el : null, el.dataset.m === "1");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeSheet();
    const el = ev.target.closest && ev.target.closest(".h[data-c]");
    if (el && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); el.click(); }
  });
  backdrop.addEventListener("click", () => closeSheet());
  document.getElementById("sheet-close").addEventListener("click", () => closeSheet());

  // ---------- find ----------

  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function buildIndex() {
    const rows = [];
    const add = (head, e, word) => {
      const extra = (e.more || []).map((m) => [m.kw, m.py, m.parts, (m.also || []).join(" ")].join(" "));
      rows.push({
        head, e, word,
        hay: fold([head, e.kw, e.py, e.parts, (e.also || []).join(" "), ...extra].join(" ")),
        kw: fold([e.kw, ...(e.more || []).map((m) => m.kw)].join(" ")).split(/[^a-z0-9']+/).filter(Boolean),
        py: fold([e.py, ...(e.more || []).map((m) => m.py)].join(" ")).split(/[^a-z]+/).filter(Boolean),
      });
    };
    for (const [c, e] of Object.entries(data.chars)) add(c, e, false);
    for (const [w, e] of Object.entries(data.words)) add(w, e, true);
    for (const [key, e] of Object.entries(data.mwords)) {
      rows.push({
        head: e.s, key, modern: true, word: true, e: { kw: e.g, py: e.py, n: e.n },
        hay: fold([e.s, e.g, e.py, e.parts, e.trad].join(" ")),
        kw: fold(e.g).split(/[^a-z0-9']+/).filter(Boolean),
        py: fold(e.py).split(/[^a-z]+/).filter(Boolean),
      });
    }
    return rows;
  }

  function search(q) {
    const terms = fold(q).split(/\s+/).map((t) => t.replace(/[1-5]$/, "")).filter(Boolean);
    if (!terms.length) return [];
    data.index = data.index || buildIndex();
    const hits = [];
    for (const row of data.index) {
      let score = 0;
      for (const t of terms) {
        if (!row.hay.includes(t)) { score = -1; break; }
        if (t === row.head) score += 100;
        else if (row.py.includes(t) || row.py.join("") === t) score += 30;
        else if (row.kw.includes(t)) score += 20;
        else if (row.kw.some((w) => w.startsWith(t))) score += 8;
        else score += 1;
      }
      // The shelf being read comes first when a word is on both.
      if (score > 0) hits.push({ row, score: score + (!!row.modern === (lang === "zh-Hans") ? 2 : 0) });
    }
    hits.sort((a, b) => b.score - a.score || (b.row.e.n || 0) - (a.row.e.n || 0));
    return hits.map((x) => x.row);
  }

  function renderFind() {
    const list = h("ul", { class: "results", "aria-live": "polite" });
    const input = h("input", {
      class: "search", id: "find", type: "search", value: findQuery,
      placeholder: "Character, meaning, parts or pinyin",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search",
      "aria-label": "Find a character",
      oninput: (e) => { findQuery = e.target.value; paintResults(list, findQuery); },
    });
    render(
      topBar(homeLink(), h("h1", { class: "grow ch-num" }, "Find")),
      input,
      h("p", { class: "hint" }, "Try a meaning, a part (\"thread ladle\") or pinyin without tones (\"ze\")."),
      list);
    paintResults(list, findQuery);
    if (!findQuery && window.matchMedia("(hover: hover)").matches) input.focus();
  }

  function paintResults(list, q) {
    const hits = search(q);
    const items = hits.slice(0, 60).map((row) => h("li", null,
      h("button", { type: "button", class: "result", "data-c": row.modern ? row.key : row.head, "data-m": row.modern ? "1" : null },
        h("span", { class: "c", lang: row.modern ? "zh-Hans" : "zh-Hant" }, row.head),
        h("span", { class: "kw" }, row.e.kw || ""),
        h("span", { class: "kind" }, row.modern ? "modern" : (row.word ? "word" : (KINDS[row.e.k] || ""))))));
    const single = [...q.trim()];
    if (!hits.length && single.length === 1 && HAN.test(single[0])) {
      items.push(h("li", null, h("button", { type: "button", class: "result", "data-c": single[0] },
        h("span", { class: "c", lang: "zh-Hant" }, single[0]), h("span", { class: "kw" }, "No card yet"))));
    } else if (q.trim() && !hits.length) {
      items.push(h("li", { class: "hint" }, "Nothing matches every word. Try fewer words."));
    }
    if (hits.length > 60) items.push(h("li", { class: "hint" }, `${hits.length - 60} more: add a word to narrow it down.`));
    list.replaceChildren(...items);
  }

  // ---------- report ----------

  function periodReads() {
    const rows = [];
    for (const book of data.books) {
      book.chapters.forEach((ch, i) => {
        const rec = chRec(chKey(book, ch.n));
        const inPeriod = rec.reads.filter((r) => (r.t || 0) > (state.cut || 0));
        if (inPeriod.length) rows.push({ book, ch, i, rec, reads: inPeriod, x: inPeriod.some((r) => r.r === "x") });
      });
    }
    return rows;
  }

  function reportText() {
    const rows = periodReads();
    const lines = [rows.some((r) => shelfOf(r.book) === "modern") ? "Reading report: Analects and modern Chinese" : "Analects reading report"];
    if (rows.length) {
      const days = rows.flatMap((r) => r.reads.map((x) => x.d)).sort();
      const from = days[0], to = days[days.length - 1];
      lines.push(from === to ? dayFull(from) : dayFull(from) + " to " + dayFull(to));
    } else {
      lines.push("Nothing read since the last report.");
    }
    lines.push("");
    // ✗ counts chapters with any ✗ in this period: a later ✓ does not hide it.
    for (const book of data.books) {
      const st = bookStats(book);
      const x = rows.filter((r) => r.book === book && r.x).length;
      if (st.read || book === currentBook()) lines.push(`${book.label}: ${st.read}/${st.total} read · ${x} ✗`);
    }
    const sorted = rows.slice().sort((a, b) =>
      (a.x ? 0 : 1) - (b.x ? 0 : 1) || a.book.order - b.book.order || a.i - b.i);
    if (sorted.length) lines.push("");
    const sign = (r) => r === "x" ? "✗" : "✓";
    for (const r of sorted) {
      const lead = r.x ? "✗" : "✓";
      // "✗ 4.5  8 Nov → ✓ 10 Nov": the first mark is implied by the lead when it matches.
      const history = r.reads.map((x, j) => (j === 0 && sign(x.r) === lead ? "" : sign(x.r) + " ") + dayShort(x.d)).join(" → ");
      const looks = Object.entries(r.rec.look || {}).map(([c, k]) => k > 1 ? `${c} ×${k}` : c);
      let line = `${lead} ${r.ch.n}  ${history}`;
      if (looks.length) line += `  looked up before the key: ${looks.join(" ")}`;
      lines.push(line);
      for (const x of r.reads) {
        if (x.att) lines.push(`   Attempt ${dayShort(x.d)}: ` + x.att.trim().replace(/\s*\n\s*/g, " / "));
      }
    }
    return lines.join("\n");
  }

  function renderReport() {
    const text = reportText();
    const status = h("p", { class: "status", id: "report-status", "aria-live": "polite" });
    const actions = h("div", { class: "actions" });
    const paintActions = (mode) => actions.replaceChildren(...reportActions(mode, paintActions, status));
    paintActions("");
    const buttons = [h("button", { type: "button", class: "btn primary", id: "copy", onclick: () => copyText(text, status) }, "Copy")];
    if (navigator.share) {
      buttons.push(h("button", { type: "button", class: "btn", id: "share", onclick: () => navigator.share({ text }).catch(() => {}) }, "Share"));
    }
    render(
      topBar(homeLink(), h("h1", { class: "grow ch-num" }, "Report")),
      h("p", { class: "hint" }, "Paste this into the weekly chat with Claude."),
      h("pre", { class: "report-text", id: "report", lang: "en" }, ...zhRuns(text)),
      status,
      actions,
      bar(...buttons));
  }

  function reportActions(mode, repaint, status) {
    const cancel = () => h("button", { type: "button", class: "btn", onclick: () => repaint("") }, "Cancel");
    if (mode === "sent") {
      return [h("div", { class: "confirm" },
        h("p", null, "Start a new report? Your reading marks stay. Looked-up characters for this period are cleared."),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn primary", id: "confirm-sent", onclick: markSent }, "Mark as sent"),
          cancel()))];
    }
    if (mode === "erase") {
      return [h("div", { class: "confirm" },
        h("p", null, "Erase every mark, lookup and attempt on this phone? This cannot be undone."),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn danger", id: "confirm-erase", onclick: eraseAll }, "Erase everything"),
          cancel()))];
    }
    return [
      h("button", { type: "button", class: "btn", id: "mark-sent", onclick: () => repaint("sent") }, "Mark report as sent"),
      h("button", { type: "button", class: "btn danger", id: "erase", onclick: () => repaint("erase") }, "Erase all my data"),
    ];
  }

  function markSent() {
    state.cut = Date.now();
    for (const rec of Object.values(state.ch)) rec.look = {};
    save();
    refresh();
    setStatus("Marked as sent. A new report starts now.");
  }

  function eraseAll() {
    const size = state.settings.size;
    state = blankState();
    state.settings.size = size;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing stored anyway */ }
    findQuery = "";
    refresh();
    setStatus("All reading data erased.");
  }

  function setStatus(msg) {
    const el = document.getElementById("report-status");
    if (el) el.textContent = msg;
  }

  async function copyText(text, status) {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied.";
      return;
    } catch (e) { /* fall back to selecting a textarea */ }
    const ta = h("textarea", { readonly: true, style: "position:fixed;top:0;left:0;opacity:0;font-size:16px" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    status.textContent = ok ? "Copied." : "Could not copy. Select the text above and copy it.";
  }

  // ---------- settings ----------

  function applySettings() {
    document.documentElement.dataset.size = state.settings.size || "M";
  }

  // ---------- service worker ----------

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offer = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        const barEl = document.getElementById("update-bar");
        barEl.hidden = false;
        barEl.onclick = () => {
          reloading = true;
          worker.postMessage({ type: "skipWaiting" });
        };
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => { if (w.state === "installed") offer(w); });
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    }).catch(() => {});
    // Only reload when the reader asked for the update.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) location.reload();
    });
  }

  // ---------- start ----------

  applySettings();
  window.addEventListener("hashchange", route);
  window.addEventListener("pagehide", flushAttempt);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAttempt();
  });
  loadData().then(route, (err) => {
    render(h("p", { class: "error" }, "Could not load the texts. Check the connection and reload."));
    console.warn(err);
  });
  registerWorker();
})();
