// Analects Reader: one-file app. Plain DOM, hash routes, localStorage.
// Five sections behind a bottom tab bar: Read, Path, Words, Grammar, Me.
"use strict";

(() => {
  const STORE_KEY = "analects-reader.v1";
  const HAN = /\p{Script=Han}/u;
  const HAN_RUN = /(\p{Script=Han}+)/u;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const KINDS = { character: "character", grammar: "grammar word", component: "component", word: "word" };
  const PLECO = "plecoapi://x-callback-url/s?q=";

  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const sheet = document.getElementById("sheet");
  const sheetBody = document.getElementById("sheet-body");
  const sheetBack = document.getElementById("sheet-back");
  const backdrop = document.getElementById("sheet-backdrop");

  const data = {
    books: [], byId: {}, chars: {}, words: {}, alias: {}, mwords: {}, pairs: {}, version: null, index: null,
    path: null,      // path.json, normalised; null when the Path is not built
    pidx: {},        // char -> [stage, keyword] (path-index.json; else from path.json with keyword "")
    stages: {},      // n -> path-NN.json, normalised; null when not written or missing. Absent until asked for.
    pent: {},        // char -> { e: entry, n: stage, g: family title }, from the stage files loaded so far
    ptrad: {},       // traditional form -> simplified Path character, from the stage files loaded so far
    patterns: null,  // patterns.json patterns, or null
    han: {},         // modern book id -> { counts: Map(char -> running count), total }
  };
  let state = loadState();
  let storageOK = true;
  let lastRoute = "";
  let sheetOpener = null;
  let sheetCur = null;       // what the sheet shows: { c, ctx, mode }
  let sheetStack = [];       // sheets opened from inside the sheet, for its Back button
  let findQuery = "";
  let wordsQuery = "";
  let wordsKind = "all";     // all | grammar
  let wordsSort = "met";     // met | common
  let meStatus = "";
  let drillReveal = false;
  const shownEn = new Set(); // sentence English opened on this visit to the app
  const scrollMem = {};      // hash -> scrollY, so going back lands where you were
  const tabLast = {};        // tab -> last hash visited in it
  let pendingAttempt = null; // unsaved textarea edit: a function that saves it
  // The current chapter visit. After a mark, the key and "Next chapter" stay for
  // the rest of the visit even if midnight passes.
  let visit = { key: "", keyOpen: false, mark: "", readT: 0, att: null };
  // Language tag of the screen being drawn: Traditional glyphs for the Analects,
  // Simplified for the modern shelf and the Path.
  let lang = "zh-Hant";

  // ---------- storage ----------
  //
  // localStorage["analects-reader.v1"]:
  // {
  //   v: 1,
  //   ch: { "book-04:4.5": { reads: [{ d: "2026-11-14", r: "ok" | "x", t: ms, att?: "typed attempt" }],
  //                          look: { "造": 1 },   // looked up before the key, this report period
  //                          att: "", attDay: "", keyDay: "" } },
  //   settings: { size: "S" | "M" | "L", hideKw: false },   // hideKw: keywords hidden on stage pages
  //   book: "book-04", mbook: "m-lunyu-04", shelf: "classical" | "modern",
  //   cut: ms,                                     // when the last report was marked as sent
  //   path: { "河": { k: 1, d: "2026-11-14", t: ms, x: 2, xt: ms } },
  //          // k: 1 marked known, 0 marked not known; d, t: day and time of the last change;
  //          // x: times marked ✗ in a drill (all time); xt: time of the last drill ✗
  //   drill: { n: 7, only: false, q: ["河", …], size: 100, ok: 0, no: 0, x: ["活"] } | null
  //          // the drill in progress: q is what is left (front = now); x: marked ✗ this round
  // }

  function blankState() {
    return { v: 1, ch: {}, settings: { size: "M", hideKw: false }, book: null, cut: 0, shelf: "classical", mbook: null, path: {}, drill: null };
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
  function int(x) { return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0; }
  function oneHan(c) { return typeof c === "string" && [...c].length === 1 && HAN.test(c); }

  // Coerce saved JSON to the expected shape, dropping whatever cannot be used.
  function normState(s) {
    const out = blankState();
    if (!isObj(s) || s.v !== 1) return out;
    if (isObj(s.settings)) {
      if (["S", "M", "L"].includes(s.settings.size)) out.settings.size = s.settings.size;
      out.settings.hideKw = s.settings.hideKw === true;
    }
    if (typeof s.book === "string") out.book = s.book;
    if (s.shelf === "modern") out.shelf = "modern";
    if (typeof s.mbook === "string") out.mbook = s.mbook;
    if (Number.isFinite(s.cut)) out.cut = s.cut;
    if (isObj(s.ch)) {
      for (const [k, r] of Object.entries(s.ch)) if (isObj(r)) out.ch[k] = normRec(r);
    }
    if (isObj(s.path)) {
      for (const [c, r] of Object.entries(s.path)) {
        if (!oneHan(c) || !isObj(r) || (r.k !== 0 && r.k !== 1)) continue;
        out.path[c] = { k: r.k, d: DAY.test(str(r.d)) ? r.d : "", t: int(r.t), x: int(r.x), xt: int(r.xt) };
      }
    }
    const d = s.drill;
    if (isObj(d) && Number.isInteger(d.n) && Array.isArray(d.q)) {
      const q = d.q.filter(oneHan);
      out.drill = { n: d.n, only: d.only === true, q, size: Math.max(int(d.size), q.length), ok: int(d.ok), no: int(d.no),
        x: Array.isArray(d.x) ? d.x.filter(oneHan) : [] };
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
  const num = (n) => n.toLocaleString("en-GB");

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

  // Fixed markup only (icons, rings built from numbers): never data.
  function markup(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    return t.content.firstElementChild;
  }

  const ICON = {
    back: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    prev: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const icon = (name) => markup(ICON[name]);

  // A thin circle that fills as the stage is learnt; the count sits inside.
  function ring(k, total) {
    const C = 2 * Math.PI * 16;
    const f = total ? Math.min(1, k / total) : 0;
    const el = markup(`<svg class="ring${f >= 1 ? " full" : ""}" viewBox="0 0 40 40" aria-hidden="true">` +
      `<circle class="track" cx="20" cy="20" r="16"/>` +
      (f > 0 ? `<circle class="fill" cx="20" cy="20" r="16" stroke-dasharray="${(f * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 20 20)"/>` : "") +
      `<text x="20" y="20" dy=".36em" text-anchor="middle">${Math.floor(k)}</text></svg>`);
    return el;
  }

  // A hairline meter. parts: fractions laid end to end (the second is drawn lighter).
  function meter(parts, label) {
    const segs = [];
    let at = 0;
    parts.forEach((f, i) => {
      const w = Math.max(0, Math.min(1 - at, f || 0));
      segs.push(h("span", { class: "seg-" + i, style: `left:${(at * 100).toFixed(2)}%;width:${(w * 100).toFixed(2)}%` }));
      at += w;
    });
    return h("span", { class: "meter", role: label ? "img" : null, "aria-label": label || null, "aria-hidden": label ? null : "true" }, segs);
  }

  // Wraps runs of Han in a lang tag so phones pick the right glyphs for the shelf.
  function zhRuns(text, lg) {
    return String(text).split(HAN_RUN).filter(Boolean)
      .map((part) => HAN.test(part) ? h("span", { lang: lg || lang }, part) : part);
  }

  // Every Han character becomes its own tappable span; punctuation stays text.
  // path: the character opens its Path card (modern content).
  function tappable(text, path) {
    return [...text].map((c) => HAN.test(c)
      ? h("span", { class: "h", "data-c": c, "data-p": path ? "1" : null, role: "button", tabindex: "0" }, c)
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
    const optional = (url) => getJSON(url).catch(() => null);
    const [books, chars, modern, path, pidx, pats] = await Promise.all([
      Promise.all(list.books.map((b) => getJSON(b.file).then((full) => Object.assign({}, b, full)))),
      getJSON("data/chars.json"),
      getJSON("data/modern-words.json").catch(() => ({ words: {} })),
      optional("data/path.json"),
      optional("data/path-index.json"),
      optional("data/patterns.json"),
    ]);
    books.sort((a, b) => a.order - b.order);
    data.books = books;
    books.forEach((b) => { data.byId[b.id] = b; });
    data.chars = chars.chars || {};
    data.words = chars.words || {};
    data.mwords = isObj(modern && modern.words) ? modern.words : {};
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
    // Running characters of each modern text, for "how much of it you know".
    for (const b of shelfBooks("modern")) {
      const counts = new Map();
      let total = 0;
      for (const ch of b.chapters) {
        for (const c of String(ch.text || "")) {
          if (!HAN.test(c)) continue;
          counts.set(c, (counts.get(c) || 0) + 1);
          total++;
        }
      }
      data.han[b.id] = { counts, total };
    }
    try { setPath(path, pidx); } catch (e) { console.warn(e); data.path = null; data.pidx = {}; }
    if (isObj(pats) && Array.isArray(pats.patterns)) {
      data.patterns = pats.patterns.filter(isObj).map((p) => ({
        key: str(p.key), title: str(p.title), shape: str(p.shape), say: str(p.say), classical: str(p.classical),
        examples: (Array.isArray(p.examples) ? p.examples : []).filter((x) => isObj(x) && str(x.zh))
          .map((x) => ({ id: x.id, zh: x.zh, en: str(x.en) })),
      })).filter((p) => p.key);
      data.patternCredit = str(pats.credit);
    }
    getJSON("version.json").then((v) => { data.version = v; paintVersion(); }).catch(() => {});
  }

  // path.json and path-index.json, checked: anything malformed is dropped, never fatal.
  function setPath(path, pidx) {
    if (!isObj(path) || !Array.isArray(path.stages) || !path.stages.length) return;
    const stages = [];
    for (const s of path.stages) {
      if (!isObj(s) || !Number.isInteger(s.n)) continue;
      const chars = [...str(s.chars)].filter((c) => HAN.test(c));
      stages.push({ n: s.n, title: str(s.title), file: str(s.file) || null, chars, size: chars.length,
        groups: Array.isArray(s.groups) ? s.groups.filter(Array.isArray) : [] });
    }
    if (!stages.length) return;
    stages.sort((a, b) => a.n - b.n);
    const texts = (Array.isArray(path.texts) ? path.texts : []).filter((t) => isObj(t) && str(t.id) && Array.isArray(t.cover))
      .map((t) => ({ id: t.id, label: str(t.label), han: int(t.han), cover: t.cover.map((x) => Number(x) || 0) }));
    const total = int(path.total) || stages.reduce((a, s) => a + s.size, 0);
    data.path = { total, stages, byN: Object.fromEntries(stages.map((s) => [s.n, s])), texts, credit: str(path.credit) };
    data.pidx = {};
    for (const s of stages) for (const c of s.chars) if (!data.pidx[c]) data.pidx[c] = [s.n, ""];
    if (isObj(pidx)) {
      for (const [c, r] of Object.entries(pidx)) {
        if (oneHan(c) && Array.isArray(r) && Number.isInteger(r[0])) data.pidx[c] = [r[0], str(r[1])];
      }
    }
  }

  const stageLoads = {};
  function loadStage(n) {
    if (n in data.stages) return Promise.resolve(data.stages[n]);
    if (stageLoads[n]) return stageLoads[n];
    const st = data.path && data.path.byN[n];
    if (!st) { data.stages[n] = null; return Promise.resolve(null); }
    // A stage not written yet (file: null) may still have its sentences in
    // data/path-NN.json; the app copes if that file is not there.
    stageLoads[n] = getJSON(st.file || stageFile(n)).then((obj) => {
      const sf = normStage(obj, n);
      data.stages[n] = sf;
      return sf;
    }).catch((err) => {
      console.warn(err);
      data.stages[n] = null;
      return null;
    });
    return stageLoads[n];
  }

  const stageFile = (n) => "data/path-" + String(n).padStart(2, "0") + ".json";
  // A stage with its families written (keywords, parts, stories), not only sentences.
  const written = (sf) => !!(sf && sf.groups.length);

  function normStage(obj, n) {
    if (!isObj(obj) || !Array.isArray(obj.groups)) return null;
    const groups = obj.groups.filter(isObj).map((g) => ({
      title: str(g.title), note: str(g.note),
      chars: (Array.isArray(g.chars) ? g.chars : []).filter((e) => isObj(e) && oneHan(e.c)).map((e) => ({
        c: e.c, rank: int(e.rank), py: str(e.py), kw: str(e.kw), parts: str(e.parts), story: str(e.story),
        trad: str(e.trad), note: str(e.note), have: ["analects", "shape"].includes(e.have) ? e.have : "new", akw: str(e.akw),
        words: (Array.isArray(e.words) ? e.words : []).filter((w) => isObj(w) && str(w.w)).map((w) => ({ w: w.w, py: str(w.py), g: str(w.g) })),
      })),
    })).filter((g) => g.chars.length);
    const sentences = (Array.isArray(obj.sentences) ? obj.sentences : []).filter((x) => isObj(x) && str(x.zh))
      .map((x) => ({ id: x.id, zh: x.zh, en: str(x.en) }));
    for (const g of groups) {
      for (const e of g.chars) {
        data.pent[e.c] = { e, n, g: g.title };
        for (const t of e.trad) if (HAN.test(t) && !data.ptrad[t]) data.ptrad[t] = e.c;
      }
    }
    return { n, title: str(obj.title), groups, sentences, chars: groups.flatMap((g) => g.chars.map((e) => e.c)) };
  }

  function lookup(c) {
    if (data.chars[c]) return { head: c, e: data.chars[c] };
    if (data.words[c]) return { head: c, e: data.words[c], word: true };
    if (data.alias[c]) return { head: data.alias[c], e: data.chars[data.alias[c]] };
    return null;
  }

  // ---------- the Path: marks and counts ----------

  const stageOf = (c) => (data.pidx[c] ? data.pidx[c][0] : 0);
  function kwOf(c) {
    if (data.pent[c]) return data.pent[c].e.kw;
    return data.pidx[c] ? data.pidx[c][1] : "";
  }
  const isKnown = (c) => !!(state.path[c] && state.path[c].k === 1);
  const markOf = (c) => (state.path[c] ? state.path[c].k : -1);

  function setKnown(c, k, drillX) {
    const prev = state.path[c] || { x: 0, xt: 0 };
    const now = Date.now();
    state.path[c] = { k, d: today(), t: now, x: (prev.x || 0) + (drillX ? 1 : 0), xt: drillX ? now : (prev.xt || 0) };
  }

  function knownCount() {
    let n = 0;
    for (const c in state.path) if (state.path[c].k === 1 && data.pidx[c]) n++;
    return n;
  }

  function stageKnown(st) {
    let n = 0;
    for (const c of st.chars) if (isKnown(c)) n++;
    return n;
  }

  // The stage he is on: the first with fewer than four in five known.
  function curStage() {
    const ss = data.path.stages;
    return ss.find((s) => stageKnown(s) < s.size * 0.8) || ss[ss.length - 1];
  }

  // Share of a modern text's running characters he has marked known (exact).
  function bookCover(id) {
    const hc = data.han[id];
    if (!hc || !hc.total) return null;
    let k = 0;
    for (const [c, n] of hc.counts) if (isKnown(c)) k += n;
    return k / hc.total;
  }

  function stageGain(id, st) {
    const hc = data.han[id];
    if (!hc || !hc.total) return 0;
    let g = 0;
    for (const c of st.chars) if (!isKnown(c)) g += hc.counts.get(c) || 0;
    return g / hc.total;
  }

  // For a text whose words are not on the phone (孔乙己): path.json's cumulative
  // cover, weighted by how much of each stage he knows.
  function estCover(t) {
    let est = 0, prev = 0;
    for (const s of data.path.stages) {
      const cum = (t.cover[s.n - 1] || prev * 100) / 100;
      est += (s.size ? stageKnown(s) / s.size : 0) * Math.max(0, cum - prev);
      prev = cum;
    }
    return est;
  }

  function estGain(t, st) {
    const cum = (t.cover[st.n - 1] || 0) / 100;
    const before = st.n > 1 ? (t.cover[st.n - 2] || 0) / 100 : 0;
    return (st.size ? 1 - stageKnown(st) / st.size : 0) * Math.max(0, cum - before);
  }

  const pct = (f) => Math.round(f * 100) + "%";

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
  const unitOf = (book) => shelfOf(book) === "modern" ? "passages" : "chapters";
  // "Book 4 里仁" with its title 里仁 → "Book 4"; "里仁 in modern Chinese" → "in modern Chinese".
  const subLabel = (book) => (book.title ? String(book.label).replace(book.title, "") : book.label)
    .replace(/\s+/g, " ").trim().replace(/^\((.*)\)$/, "$1");

  // ---------- routing ----------

  const TAB_ROOT = { read: "#/", path: "#/path", words: "#/words", grammar: "#/grammar", me: "#/me" };

  function route() {
    if (!data.books.length) return; // a hash change while the texts are still loading
    flushAttempt();
    const hash = location.hash || "#/";
    let parts;
    try { parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent); } catch (e) { parts = [""]; }
    // A stage page waits (a moment, from the cache) for its stage file.
    if (parts[0] === "path" && parts[1] && data.path) {
      const n = Number(parts[1]);
      if (data.path.byN[n] && !(n in data.stages)) {
        loadStage(n).then(() => { if ((location.hash || "#/") === hash) route(); });
        return;
      }
    }
    const same = hash === lastRoute;
    if (!same) {
      closeSheet(false);
      if (lastRoute) scrollMem[lastRoute] = window.scrollY;
    }
    const y = window.scrollY;
    lastRoute = hash;
    let tab = "read", focus = false;
    try {
      const isChapter = parts[0] === "c" && data.byId[parts[1]];
      const key = isChapter ? parts[1] + ":" + parts[2] : "";
      if (visit.key !== key) visit = { key, keyOpen: false, mark: "", readT: 0, att: null };
      // Find and the report keep the shelf's script (Find ranks that shelf first).
      lang = ["path", "words", "grammar"].includes(parts[0]) ? "zh-Hans" : langOf(isChapter ? data.byId[parts[1]] : currentBook());
      if (parts[0] !== "path" || parts[2] !== "drill") drillReveal = false;
      if (isChapter) { focus = true; renderChapter(data.byId[parts[1]], parts[2]); }
      else if (parts[0] === "path") {
        tab = "path";
        const n = Number(parts[1]);
        if (!parts[1]) renderPath();
        else if (parts[2] === "drill") { focus = true; renderDrill(n); }
        else if (parts[2] === "sentences") renderSentences(n);
        else renderStage(n);
      } else if (parts[0] === "words") { tab = "words"; renderWords(); }
      else if (parts[0] === "grammar") { tab = "grammar"; if (parts[1]) renderPattern(Number(parts[1])); else renderGrammar(); }
      else if (parts[0] === "me") { tab = "me"; renderMe(); }
      else if (parts[0] === "find") { tab = "me"; renderFind(); }
      else if (parts[0] === "report") { tab = "me"; renderReport(); }
      else renderRead();
    } catch (err) {
      // A malformed link or odd saved data must never strand him on a blank page.
      console.warn(err);
      visit = { key: "", keyOpen: false, mark: "", readT: 0, att: null };
      tab = "read"; focus = false;
      lang = langOf(currentBook());
      renderRead();
    }
    setChrome(tab, focus, hash);
    window.scrollTo(0, same ? y : (scrollMem[hash] || 0));
    if (!same) enter();
  }

  // Re-render the current screen, keeping the scroll position.
  const refresh = () => route();

  function setChrome(tab, focus, hash) {
    document.body.classList.toggle("focus", focus);
    document.body.dataset.tab = tab;
    if (!focus) tabLast[tab] = hash;
    for (const a of tabs.querySelectorAll("a[data-tab]")) {
      const t = a.dataset.tab;
      const on = t === tab;
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      a.setAttribute("href", on ? TAB_ROOT[t] : (tabLast[t] || TAB_ROOT[t]));
    }
  }

  function enter() {
    if (reducedMotion()) return;
    app.classList.remove("enter");
    void app.offsetWidth;
    app.classList.add("enter");
  }

  // A tab already open takes you to its top, as on iOS.
  tabs.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-tab]");
    if (!a) return;
    if (a.getAttribute("aria-current") === "page" && (location.hash || "#/") === TAB_ROOT[a.dataset.tab]) {
      ev.preventDefault();
      window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  });

  // Page head for a section: a seal and a title.
  function masthead(sealCh, title, sub, ...extra) {
    return h("header", { class: "mast" },
      h("span", { class: "seal", lang: "zh-Hans", "aria-hidden": "true" }, sealCh),
      h("div", { class: "grow" }, h("h1", null, title), sub ? h("p", { class: "mast-sub" }, sub) : null),
      ...extra);
  }

  // Head for a page inside a section: back, title, and up to two controls.
  function topBar(back, title, ...right) {
    return h("header", { class: "top" },
      h("div", { class: "top-l" },
        back ? h("a", { class: "back", href: back.href, "aria-label": back.aria || ("Back to " + back.label) }, icon("back"), h("span", null, ...zhRuns(back.label))) : null),
      h("div", { class: "top-title" }, title),
      h("div", { class: "top-r" }, ...right));
  }

  function bar(...kids) {
    return h("nav", { class: "bar" }, h("div", { class: "bar-inner" }, ...kids));
  }

  const label = (text, aside) => h("h2", { class: "section-label" }, h("span", null, text), aside ? h("span", { class: "aside" }, aside) : null);

  // ---------- Read ----------

  function renderRead() {
    const book = currentBook();
    const shelf = shelfOf(book);
    const kids = [
      masthead("读", "Read", null, h("a", { class: "text-btn", href: "#/find" }, "Find")),
      shelfSwitch(book),
    ];
    if (!storageOK) kids.push(h("p", { class: "status" }, "This browser is not saving your marks."));
    const list = h("div", { class: "books" });
    for (const b of shelfBooks(shelf)) list.append(b === book ? openBook(b) : closedBook(b));
    kids.push(list);
    kids.push(h("footer", { class: "foot" }, h("p", null, "Translations are Claude's own: check against a published one.")));
    render(...kids);
  }

  function continueLink(book, cls) {
    const next = firstUnread(book);
    const st = bookStats(book);
    if (next) return h("a", { class: cls, href: chHref(book, next.n) }, "Continue " + next.n);
    const shelf = shelfBooks(shelfOf(book));
    const later = shelf.slice(shelf.indexOf(book) + 1).find(firstUnread);
    if (later) {
      return h("button", { class: cls, type: "button", onclick: () => { setBook(later); save(); location.hash = chHref(later, firstUnread(later).n); } },
        "Continue ", ...zhRuns(later.label, langOf(later)));
    }
    return h("button", { class: cls, type: "button", disabled: true }, `All ${st.total} read`);
  }

  function coverLine(book) {
    if (shelfOf(book) !== "modern" || !data.path) return null;
    const f = bookCover(book.id);
    if (f === null) return null;
    return h("div", { class: "cover" },
      h("p", null, h("strong", null, pct(f)), " of its running characters marked known",
        knownCount() ? null : h("span", { class: "aside" }, " · mark them in the Path")),
      meter([f]));
  }

  function openBook(book) {
    const lg = langOf(book);
    const st = bookStats(book);
    const unit = unitOf(book);
    const next = firstUnread(book);
    const kids = [
      h("div", { class: "book-head" },
        h("span", { class: "seal big", lang: lg, "aria-hidden": "true" }, book.seal || "論"),
        h("div", { class: "grow" },
          h("h2", { class: "book-title", lang: lg }, book.title || book.label),
          h("p", { class: "book-label" }, ...zhRuns(subLabel(book), lg)))),
      h("div", { class: "book-prog" },
        h("p", { class: "progress" }, `${st.read} of ${st.total} ${unit} read`,
          st.x ? h("span", { class: "x" }, `, ${st.x} ✗`) : null),
        meter([st.read / st.total])),
      coverLine(book),
      continueLink(book, "btn primary continue"),
    ];

    const re = rereadDay(book, today());
    if (re) {
      kids.push(label("Re-read cold", "from " + dayLong(re.day)));
      kids.push(h("div", { class: "reread" }, re.chapters.map((c) => {
        const last = lastRead(chRec(chKey(book, c.n)));
        return h("a", { class: "pill" + (last && last.r === "x" ? " x" : ""), href: chHref(book, c.n) },
          c.n, last && last.r === "x" ? "✗" : null);
      })));
    }
    kids.push(label(unit === "passages" ? "Passages" : "Chapters"));
    kids.push(h("div", { class: "grid" }, book.chapters.map((c) => chip(book, c, next))));
    if (book.credit) kids.push(h("p", { class: "credit" }, book.credit));
    return h("section", { class: "book open", "aria-label": book.label }, ...kids);
  }

  function closedBook(book) {
    const lg = langOf(book);
    const st = bookStats(book);
    const f = shelfOf(book) === "modern" && data.path ? bookCover(book.id) : null;
    return h("section", { class: "book closed", "aria-label": book.label },
      h("button", { type: "button", class: "book-open", onclick: () => { setBook(book); save(); refresh(); } },
        h("span", { class: "seal", lang: lg, "aria-hidden": "true" }, book.seal || "論"),
        h("span", { class: "grow" },
          h("span", { class: "book-title", lang: lg }, book.title || book.label),
          h("span", { class: "book-label" }, ...zhRuns(subLabel(book), lg)),
          h("span", { class: "progress" }, `${st.read} of ${st.total} ${unitOf(book)} read`,
            st.x ? `, ${st.x} ✗` : "", f !== null ? ` · ${pct(f)} known` : ""))),
      continueLink(book, "continue-mini"));
  }

  // Classical | Modern. Shown only once there is something on the modern shelf.
  function shelfSwitch(book) {
    if (!shelfBooks("modern").length) return null;
    const cur = shelfOf(book);
    return h("div", { class: "seg shelf", role: "group", "aria-label": "Shelf" },
      [["classical", "Classical", "古"], ["modern", "Modern", "今"]].map(([id, name, zh]) => h("button", {
        type: "button",
        id: "shelf-" + id,
        "aria-pressed": String(id === cur),
        onclick: () => { state.shelf = id; save(); refresh(); },
      }, h("span", { class: "zh", lang: id === "modern" ? "zh-Hans" : "zh-Hant", "aria-hidden": "true" }, zh), name)));
  }

  function chip(book, c, next) {
    const last = lastRead(chRec(chKey(book, c.n)));
    const cls = "chip" + (last ? (last.r === "x" ? " x" : " ok") : "") + (next && next.n === c.n ? " next" : "");
    const lab = c.n + (last ? (last.r === "x" ? ", came out wrong" : ", got it") : ", not read");
    return h("a", { class: cls, href: chHref(book, c.n), "aria-label": lab },
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
    const lg = langOf(book);

    const step = (to, dir, what) => to
      ? h("a", { class: "icon-btn", href: chHref(to.book, to.ch.n), "aria-label": what + " " + to.ch.n }, icon(dir))
      : h("button", { class: "icon-btn", type: "button", disabled: true, "aria-label": "No " + what.toLowerCase() }, icon(dir));

    const kids = [
      topBar({ href: "#/", label: book.title || "Read", aria: "Back to Read" },
        h("h1", null,
          h("span", { class: "ch-num" }, ch.n),
          h("span", { class: "ch-pos" }, `${idx + 1} / ${book.chapters.length}`)),
        step(prev, "prev", "Previous chapter"),
        step(next, "next", "Next chapter")),
      h("p", { class: "text" + (ch.toks ? " modern" : ""), lang, "data-ctx": key },
        ch.toks ? tappableToks(ch.toks) : tappable(ch.text)),
    ];

    if (ch.new && ch.new.length) {
      kids.push(label("New"));
      kids.push(h("div", { class: "chars" }, ch.new.map((c) => ch.toks
        ? h("button", { type: "button", class: "char-btn word", lang: lg, "data-c": c, "data-m": "1", "data-ctx": key }, surfaceOf(c))
        : h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": c, "data-ctx": key }, c))));
    }
    if (ch.gloss && ch.gloss.length) {
      kids.push(label("Glossed"));
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
      "aria-label": "Your attempt",
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
    if (ch.wfw && ch.wfw.length) kids.push(label("Word for word"), wfwBlock(ch.wfw));
    else if (ch.literal) kids.push(label("Word for word"), literalBlock(ch.literal));
    if (ch.translation) kids.push(label("Translation"), h("p", { class: "translation" }, ...zhRuns(ch.translation)));
    if (ch.note) kids.push(label("Note"), h("p", { class: "note" }, ...zhRuns(ch.note)));
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
    const back = h("a", { class: "btn icon", href: "#/", "aria-label": "Back to Read" }, icon("back"));
    if (!keyShown) {
      return bar(back, h("button", {
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
      return bar(back, ok, x, go);
    }
    return bar(back, ok, x);
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

  // ---------- Path ----------

  function noPath(title, sealCh) {
    render(masthead(sealCh, title),
      h("div", { class: "empty" },
        h("p", null, "The Path is not on this phone yet."),
        h("p", { class: "aside" }, "It arrives with a later update: thirty stages of a hundred characters, each with a keyword, its parts and a short story.")));
  }

  function renderPath() {
    if (!data.path) { noPath("Path", "路"); return; }
    const P = data.path;
    const known = knownCount();
    const gained = Object.entries(state.path).filter(([c, r]) => r.k === 1 && r.t > (state.cut || 0) && data.pidx[c]).length;
    const cur = curStage();
    const kids = [masthead("路", "Path", `The first ${num(P.total)} characters`)];

    kids.push(h("section", { class: "tally", "aria-label": "Characters known" },
      h("p", { class: "big" }, h("span", { class: "big-n" }, num(known)), h("span", { class: "big-of" }, ` of ${num(P.total)}`)),
      h("p", { class: "big-cap" }, "characters marked known",
        gained ? h("span", { class: "aside" }, ` · ${gained} since the last report`) : null),
      meter([known / P.total])));

    kids.push(h("a", { class: "btn primary go-stage", href: "#/path/" + cur.n },
      h("span", null, "Stage ", cur.n),
      h("span", { class: "go-title" }, cur.title || "not written yet")));

    if (P.texts.length) {
      kids.push(label("What this unlocks", "stage " + cur.n + " next"));
      kids.push(h("ul", { class: "unlocks" }, P.texts.map((t) => unlockRow(t, cur))));
    }

    kids.push(label("Stages", "known of " + (P.stages[0] ? P.stages[0].size : 100)));
    kids.push(h("ol", { class: "stages" }, P.stages.map((s) => {
      const k = stageKnown(s);
      return h("li", null, h("a", { class: "stage-row" + (s.file ? "" : " unwritten") + (s === cur ? " cur" : ""), href: "#/path/" + s.n,
        "aria-label": `Stage ${s.n}, ${s.title || "not written yet"}, ${k} of ${s.size} known` },
        h("span", { class: "stage-n", "aria-hidden": "true" }, s.n),
        h("span", { class: "stage-mid", "aria-hidden": "true" },
          h("span", { class: "stage-title" }, s.title || "Not written yet"),
          h("span", { class: "stage-hint", lang: "zh-Hans" }, s.chars.slice(0, 18).join(""))),
        ring(k, s.size)));
    })));
    if (P.credit) kids.push(h("p", { class: "credit" }, P.credit));
    render(...kids);
  }

  function unlockRow(t, cur) {
    const book = data.byId[t.id];
    const exact = book && data.han[t.id] && data.han[t.id].total ? bookCover(t.id) : null;
    const now = exact !== null ? exact : estCover(t);
    const gain = exact !== null ? stageGain(t.id, cur) : estGain(t, cur);
    const title = book ? (book.title || book.label) : t.label.replace(/\s*\(.*\)$/, "");
    const sub = book ? subLabel(book) : (t.label.match(/\(([^)]*)\)/) || [, ""])[1];
    return h("li", { class: "unlock" },
      h("div", { class: "unlock-head" },
        h("span", { class: "unlock-title", lang: "zh-Hans" }, title),
        sub ? h("span", { class: "unlock-sub" }, ...zhRuns(sub, "zh-Hans")) : null),
      meter([now, gain], `${pct(now)} known now, ${pct(now + gain)} with stage ${cur.n}`),
      h("p", { class: "unlock-nums" },
        h("strong", null, (exact === null ? "about " : "") + pct(now)), " of its characters now",
        h("span", { class: "gain" }, ` · ${pct(Math.min(1, now + gain))} with stage ${cur.n}`)));
  }

  function renderStage(n) {
    if (!data.path) { noPath("Path", "路"); return; }
    const st = data.path.byN[n];
    if (!st) { location.replace("#/path"); return; }
    const sf = data.stages[n];
    const k = stageKnown(st);
    const hide = state.settings.hideKw;
    const kids = [topBar({ href: "#/path", label: "Path" }, h("h1", null, "Stage ", st.n),
      written(sf) ? h("button", {
        type: "button", class: "text-btn", id: "kw-toggle", "aria-pressed": String(hide),
        onclick: (e) => {
          state.settings.hideKw = !state.settings.hideKw;
          save();
          const on = state.settings.hideKw;
          e.currentTarget.setAttribute("aria-pressed", String(on));
          e.currentTarget.textContent = on ? "Show keywords" : "Hide keywords";
          document.querySelectorAll(".tiles").forEach((t) => t.classList.toggle("hide-kw", on));
        },
      }, hide ? "Show keywords" : "Hide keywords") : null)];

    kids.push(h("header", { class: "stage-head" },
      h("h2", { class: "stage-name" + (written(sf) ? "" : " muted") }, st.title || (written(sf) ? "Stage " + n : "Not written yet")),
      h("p", { class: "stage-count" }, h("strong", null, k), ` of ${st.size} known`),
      meter([k / (st.size || 1)])));

    if (written(sf)) {
      const unknown = sf.chars.filter((c) => !isKnown(c)).length;
      const d = state.drill;
      const acts = h("div", { class: "stage-acts" });
      if (d && d.n === n && d.q.length) {
        acts.append(h("a", { class: "btn primary", href: `#/path/${n}/drill` }, `Resume drill · ${d.q.length} left`));
      }
      acts.append(
        h("button", { type: "button", class: "btn" + (d && d.n === n && d.q.length ? "" : " primary"), id: "drill-all", onclick: () => startDrill(n, false) }, `Drill all ${sf.chars.length}`));
      // Native append() would print a null as the text "null", so add this one only when it exists.
      if (unknown !== sf.chars.length) {
        acts.append(h("button", { type: "button", class: "btn", id: "drill-new", disabled: unknown ? null : true, onclick: () => startDrill(n, true) },
          unknown ? `Only the ${unknown} I don't know` : "You know them all"));
      }
      if (sf.sentences.length) acts.append(h("a", { class: "btn", href: `#/path/${n}/sentences` }, `Sentences · ${sf.sentences.length}`));
      kids.push(acts);
      for (const g of sf.groups) {
        kids.push(h("section", { class: "family" },
          h("h3", { class: "family-title" }, ...zhRuns(g.title, "zh-Hans")),
          g.note ? h("p", { class: "family-note" }, ...zhRuns(g.note, "zh-Hans")) : null,
          h("div", { class: "tiles" + (hide ? " hide-kw" : "") }, g.chars.map((e) => tile(e.c, e.kw)))));
      }
    } else {
      if (sf && sf.sentences.length) {
        kids.push(h("div", { class: "stage-acts" }, h("a", { class: "btn", href: `#/path/${n}/sentences` }, `Sentences · ${sf.sentences.length}`)));
      }
      kids.push(h("p", { class: "note-block" },
        st.file ? "This stage's file is missing on this phone. Its characters, in the order they will be learnt:"
          : "This stage is not written yet: its keywords, parts and stories come with a later update. Its characters, commonest first:"));
      kids.push(h("div", { class: "tiles bare" }, st.chars.map((c) => tile(c, ""))));
    }
    const prev = data.path.byN[n - 1], next = data.path.byN[n + 1];
    kids.push(h("nav", { class: "pager", "aria-label": "Stages" },
      prev ? h("a", { href: "#/path/" + prev.n }, "‹ Stage " + prev.n) : h("span"),
      next ? h("a", { href: "#/path/" + next.n }, "Stage " + next.n + " ›") : h("span")));
    render(...kids);
  }

  function tile(c, kw) {
    const m = markOf(c);
    return h("button", {
      type: "button", class: "tile" + (m === 1 ? " is-known" : m === 0 ? " notyet" : ""), "data-c": c, "data-p": "1",
      "aria-label": c + (m === 1 ? ", known" : m === 0 ? ", not known yet" : ""),
    },
    h("span", { class: "tg", lang: "zh-Hans" }, c),
    kw ? h("span", { class: "tk" }, kw) : null);
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startDrill(n, only) {
    const sf = data.stages[n];
    if (!written(sf)) return;
    const q = shuffle(sf.chars.filter((c) => !only || !isKnown(c)));
    state.drill = { n, only, q, size: q.length, ok: 0, no: 0, x: [] };
    drillReveal = false;
    save();
    const to = `#/path/${n}/drill`;
    if (location.hash === to) refresh(); else location.hash = to;
  }

  function renderDrill(n) {
    const sf = data.stages[n];
    if (!written(sf)) { location.replace("#/path/" + (data.path && data.path.byN[n] ? n : "")); return; }
    let d = state.drill;
    if (!d || d.n !== n) {
      d = state.drill = { n, only: false, q: shuffle(sf.chars.slice()), size: sf.chars.length, ok: 0, no: 0, x: [] };
      save();
    }
    const done = d.size - d.q.length;
    const kids = [topBar({ href: `#/path/${n}`, label: "Stage " + n },
      h("h1", null, "Drill", h("span", { class: "ch-pos" }, d.q.length ? `${d.q.length} to go` : "done")),
      d.q.length ? h("button", { type: "button", class: "text-btn", id: "drill-end", onclick: () => { state.drill = null; save(); location.hash = `#/path/${n}`; } }, "End") : null)];
    kids.push(h("div", { class: "drill-prog" }, meter([done / (d.size || 1)])));

    if (!d.q.length) {
      const left = sf.chars.filter((c) => !isKnown(c)).length;
      kids.push(h("section", { class: "drill-done" },
        h("p", { class: "seal big", lang: "zh-Hans", "aria-hidden": "true" }, "毕"),
        h("h2", { class: "done-title" }, `Stage ${n}: round done`),
        h("p", null, `${d.size} characters, ${d.no} ✗ along the way. ${sf.chars.length - left} of ${sf.chars.length} now marked known.`),
        d.x.length ? label("Marked ✗ this round") : null,
        d.x.length ? h("div", { class: "tiles small" }, d.x.map((c) => tile(c, kwOf(c)))) : null));
      kids.push(bar(
        h("a", { class: "btn", href: `#/path/${n}` }, "Stage " + n),
        left ? h("button", { type: "button", class: "btn primary", id: "drill-again", onclick: () => startDrill(n, true) }, `Again: the ${left} I don't know`)
          : h("a", { class: "btn primary", href: "#/path" }, "Back to the Path")));
      render(...kids);
      return;
    }

    const c = d.q[0];
    const pe = data.pent[c];
    const e = pe ? pe.e : { c, kw: kwOf(c), py: "", parts: "", story: "", words: [], note: "" };
    const card = h("button", {
      type: "button", class: "flash" + (drillReveal ? " open" : ""), id: "drill-card",
      "aria-label": drillReveal ? c : "Show the keyword", "aria-expanded": String(drillReveal),
      onclick: () => { if (!drillReveal) { drillReveal = true; refresh(); } },
    }, h("span", { class: "flash-g", lang: "zh-Hans" }, c),
    drillReveal ? null : h("span", { class: "flash-hint" }, "Say what it means, then tap"));
    kids.push(card);
    if (drillReveal) {
      kids.push(h("section", { class: "answer", "aria-live": "polite" },
        h("p", { class: "answer-kw" }, e.kw || "no keyword yet"),
        e.py ? h("p", { class: "answer-py" }, e.py) : null,
        e.parts ? h("p", { class: "answer-parts" }, ...zhRuns(e.parts, "zh-Hans")) : null,
        e.story ? h("p", { class: "answer-story" }, ...zhRuns(e.story, "zh-Hans")) : null,
        e.words.length ? h("p", { class: "answer-words" }, e.words.flatMap((w, i) => [i ? " · " : "", h("span", { lang: "zh-Hans" }, w.w), " " + w.g])) : null,
        markOf(c) === 1 ? h("p", { class: "aside" }, "Marked known before.") : null));
    }
    const mark = (k) => () => {
      if (k) {
        setKnown(c, 1);
        d.q.shift();
        d.ok++;
      } else {
        setKnown(c, 0, true);
        d.q.push(d.q.shift());
        d.no++;
        if (!d.x.includes(c)) d.x.push(c);
      }
      drillReveal = false;
      save();
      refresh();
      window.scrollTo(0, 0);
    };
    kids.push(drillReveal
      ? bar(h("button", { type: "button", class: "btn x", id: "drill-x", onclick: mark(0) }, "✗ Not yet"),
        h("button", { type: "button", class: "btn primary", id: "drill-ok", onclick: mark(1) }, "✓ I know it"))
      : bar(h("button", { type: "button", class: "btn primary", id: "drill-show", onclick: () => { drillReveal = true; refresh(); } }, "Show")));
    render(...kids);
  }

  function renderSentences(n) {
    if (!data.path) { noPath("Path", "路"); return; }
    const sf = data.stages[n];
    if (!sf || !sf.sentences.length) { location.replace("#/path/" + (data.path.byN[n] ? n : "")); return; }
    render(
      topBar({ href: `#/path/${n}`, label: "Stage " + n }, h("h1", null, "Sentences")),
      h("p", { class: "hint lead" }, "Read each one and say what it means; then open the English. Tap any character for its card."),
      sentenceList(sf.sentences, "s" + n),
      h("p", { class: "credit" }, "Sentences from Tatoeba (tatoeba.org), CC BY 2.0 FR."));
  }

  // Chinese first; the English only on a tap. Every character opens its card.
  function sentenceList(list, ns) {
    return h("ol", { class: "sentences" }, list.map((s, i) => {
      const id = ns + ":" + (s.id || i);
      const open = shownEn.has(id);
      const en = h("p", { class: "en", id: "en-" + id.replace(/\W/g, "_"), hidden: open ? null : true }, s.en);
      return h("li", null,
        h("p", { class: "zh", lang: "zh-Hans" }, tappable(s.zh, true)),
        s.en ? h("button", {
          type: "button", class: "reveal", "aria-expanded": String(open), "aria-controls": en.id,
          onclick: (ev) => {
            const btn = ev.currentTarget;
            const on = btn.getAttribute("aria-expanded") !== "true";
            btn.setAttribute("aria-expanded", String(on));
            btn.textContent = on ? "Hide English" : "English";
            en.hidden = !on;
            if (on) shownEn.add(id); else shownEn.delete(id);
          },
        }, open ? "Hide English" : "English") : null,
        en);
    }));
  }

  // ---------- Words ----------

  function wordRow(key, e) {
    return h("li", null, h("button", { type: "button", class: "wrow", "data-c": key, "data-m": "1" },
      h("span", { class: "ws", lang: "zh-Hans" }, e.s || key),
      h("span", { class: "wmid" },
        h("span", { class: "wg" }, ...zhRuns(e.g || "", "zh-Hans")),
        h("span", { class: "wmeta" },
          e.py ? h("span", { class: "wpy" }, e.py) : null,
          e.src ? h("span", { class: "wsrc" }, ...zhRuns(e.src, "zh-Hans")) : null)),
      e.k === "grammar" ? h("span", { class: "wk" }, "grammar") : null));
  }

  function renderWords() {
    const all = Object.entries(data.mwords).filter(([, e]) => isObj(e));
    if (!all.length) {
      render(masthead("词", "Words"), h("div", { class: "empty" }, h("p", null, "No modern words on this phone yet.")));
      return;
    }
    const list = h("ul", { class: "wordlist" });
    const count = h("p", { class: "hint", "aria-live": "polite" });
    const paint = () => {
      const terms = fold(wordsQuery).split(/\s+/).map((t) => t.replace(/[1-5]$/, "")).filter(Boolean);
      let rows = all.filter(([, e]) => wordsKind === "all" || e.k === "grammar");
      if (terms.length) {
        rows = rows.filter(([key, e]) => {
          const hay = fold([e.s, key, e.g, e.py, e.parts, e.trad, (e.py || "").replace(/\s+/g, "")].join(" "));
          return terms.every((t) => hay.includes(t));
        });
      }
      if (wordsSort === "common") rows = rows.slice().sort((a, b) => (b[1].n || 0) - (a[1].n || 0));
      list.replaceChildren(...rows.map(([key, e]) => wordRow(key, e)));
      count.textContent = terms.length || wordsKind !== "all"
        ? `${rows.length} of ${all.length}` : `${all.length} words from your modern texts`;
    };
    const seg = (name, cur, opts, set) => h("div", { class: "seg small", role: "group", "aria-label": name },
      opts.map(([id, text]) => h("button", {
        type: "button", "aria-pressed": String(id === cur),
        onclick: (ev) => {
          set(id);
          ev.currentTarget.parentNode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === ev.currentTarget)));
          paint();
        },
      }, text)));
    const input = h("input", {
      class: "search", id: "words-q", type: "search", value: wordsQuery,
      placeholder: "Meaning, word or pinyin", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      enterkeyhint: "search", "aria-label": "Search the words",
      oninput: (e) => { wordsQuery = e.target.value; paint(); },
    });
    render(
      masthead("词", "Words", null),
      h("div", { class: "words-tools" }, input,
        h("div", { class: "row" },
          seg("Which words", wordsKind, [["all", "All"], ["grammar", "Grammar"]], (v) => { wordsKind = v; }),
          seg("Order", wordsSort, [["met", "As met"], ["common", "Commonest"]], (v) => { wordsSort = v; }))),
      count,
      list);
    paint();
  }

  // ---------- Grammar ----------

  function renderGrammar() {
    const kids = [masthead("法", "Grammar", data.patterns ? `${data.patterns.length} patterns of modern written Chinese` : null)];
    if (data.patterns && data.patterns.length) {
      kids.push(label("Patterns"));
      kids.push(h("ol", { class: "patterns" }, data.patterns.map((p, i) => h("li", null,
        h("a", { class: "prow", href: "#/grammar/" + (i + 1) },
          h("span", { class: "pk" }, ...zhRuns(p.key, "zh-Hans")),
          h("span", { class: "pt" }, ...zhRuns(p.title, "zh-Hans")),
          icon("more"))))));
    } else {
      kids.push(h("div", { class: "empty" }, h("p", null, "The grammar patterns are not on this phone yet."),
        h("p", { class: "aside" }, "They arrive with a later update. The grammar words from your texts are below.")));
    }
    const gw = Object.entries(data.mwords).filter(([, e]) => isObj(e) && e.k === "grammar")
      .sort((a, b) => (b[1].n || 0) - (a[1].n || 0));
    if (gw.length) {
      kids.push(label("Grammar words in your texts", gw.length + ", commonest first"));
      kids.push(h("ul", { class: "wordlist" }, gw.map(([key, e]) => wordRow(key, e))));
    }
    render(...kids);
  }

  function renderPattern(i) {
    const p = data.patterns && data.patterns[i - 1];
    if (!p) { location.replace("#/grammar"); return; }
    const kids = [
      topBar({ href: "#/grammar", label: "Grammar" }, h("h1", null, "Pattern", h("span", { class: "ch-pos" }, `${i} / ${data.patterns.length}`))),
      h("header", { class: "pattern-head" },
        h("p", { class: "pattern-key" }, ...zhRuns(p.key, "zh-Hans")),
        h("h2", { class: "pattern-title" }, ...zhRuns(p.title, "zh-Hans"))),
    ];
    if (p.shape) kids.push(h("p", { class: "shape" }, ...zhRuns(p.shape, "zh-Hans")));
    if (p.say) kids.push(h("p", { class: "say" }, ...zhRuns(p.say, "zh-Hans")));
    if (p.classical) kids.push(h("div", { class: "classical" }, h("p", null, h("span", { class: "lead-in" }, "In the Analects: "), ...zhRuns(p.classical, "zh-Hant"))));
    if (p.examples.length) {
      kids.push(label("Examples"));
      kids.push(sentenceList(p.examples, "g" + i));
    }
    const prev = data.patterns[i - 2], next = data.patterns[i];
    kids.push(h("nav", { class: "pager", "aria-label": "Patterns" },
      prev ? h("a", { href: "#/grammar/" + (i - 1), lang: "zh-Hans" }, "‹ " + prev.key) : h("span"),
      next ? h("a", { href: "#/grammar/" + (i + 1), lang: "zh-Hans" }, next.key + " ›") : h("span")));
    if (data.patternCredit) kids.push(h("p", { class: "credit" }, data.patternCredit));
    render(...kids);
  }

  // ---------- Me ----------

  function renderMe() {
    const kids = [masthead("我", "Me")];
    if (!storageOK) kids.push(h("p", { class: "status" }, "This browser is not saving your marks."));

    if (data.path) {
      const P = data.path;
      const known = knownCount();
      kids.push(h("section", { class: "tally small", "aria-label": "Characters known" },
        h("p", { class: "big" }, h("span", { class: "big-n" }, num(known)), h("span", { class: "big-of" }, ` of ${num(P.total)}`)),
        h("p", { class: "big-cap" }, "characters marked known"),
        h("a", { class: "strip", href: "#/path", "aria-label": "Known per stage: open the Path" },
          P.stages.map((s) => h("span", { class: "strip-bar", style: `--f:${(s.size ? stageKnown(s) / s.size : 0).toFixed(3)}` }))),
        h("p", { class: "strip-cap", "aria-hidden": "true" }, h("span", null, "stage 1"), h("span", null, "stage " + P.stages[P.stages.length - 1].n))));
    }

    const rows = [];
    for (const shelf of ["classical", "modern"]) {
      const bs = shelfBooks(shelf);
      if (!bs.length) continue;
      let read = 0, total = 0, x = 0;
      for (const b of bs) { const st = bookStats(b); read += st.read; total += st.total; x += st.x; }
      rows.push([shelf === "modern" ? "Modern" : "Classical", `${read} of ${total} ${shelf === "modern" ? "passages" : "chapters"} read` + (x ? ` · ${x} ✗` : "")]);
    }
    let looks = 0;
    for (const rec of Object.values(state.ch)) for (const n of Object.values(rec.look || {})) looks += n;
    rows.push(["Looked up", `${looks} before the key, since the last report`]);
    kids.push(label("Reading"));
    kids.push(h("dl", { class: "facts" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])));

    kids.push(h("nav", { class: "links", "aria-label": "Tools" },
      h("a", { class: "linkrow", href: "#/report" }, h("span", null, "Report", h("small", null, "for the weekly chat")), icon("more")),
      h("a", { class: "linkrow", href: "#/find" }, h("span", null, "Find", h("small", null, "a character you cannot type")), icon("more"))));

    kids.push(label("Settings"));
    kids.push(h("div", { class: "settings" }, h("span", null, "Reading text size"), sizeSetting()));
    if (data.path) {
      kids.push(h("div", { class: "setting-block" },
        h("button", { type: "button", class: "btn", id: "mark-analects", onclick: markAnalects }, "Mark the characters I have Analects cards for as known"),
        h("p", { class: "status", id: "me-status", "aria-live": "polite" }, meStatus)));
    }

    const danger = h("div", { class: "actions" });
    const paintDanger = (mode) => danger.replaceChildren(...(mode === "erase"
      ? [h("div", { class: "confirm" },
        h("p", null, "Erase every mark, lookup, attempt and known character on this phone? This cannot be undone."),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn danger", id: "confirm-erase", onclick: eraseAll }, "Erase everything"),
          h("button", { type: "button", class: "btn", onclick: () => paintDanger("") }, "Cancel")))]
      : [h("button", { type: "button", class: "btn danger", id: "erase", onclick: () => paintDanger("erase") }, "Erase all my data")]));
    paintDanger("");
    kids.push(danger);

    kids.push(h("footer", { class: "foot" },
      h("p", { id: "version" }, versionText()),
      h("p", null, "Translations are Claude's own: check against a published one."),
      h("p", null, "Marks live only in this phone's browser. Copy the report to keep a record.")));
    render(...kids);
    meStatus = "";
  }

  async function markAnalects() {
    const btn = document.getElementById("mark-analects");
    if (btn) btn.disabled = true;
    const P = data.path;
    await Promise.all(P.stages.map((s) => loadStage(s.n)));
    let added = 0, left = 0;
    const mark = (c) => {
      if (!state.path[c]) { setKnown(c, 1); added++; } else if (state.path[c].k === 0) left++;
    };
    for (const s of P.stages) {
      const sf = data.stages[s.n];
      if (written(sf)) {
        for (const g of sf.groups) for (const e of g.chars) if (e.have !== "new") mark(e.c);
      } else {
        // Not written yet: same-shape Analects cards are still known.
        for (const c of s.chars) if (data.chars[c]) mark(c);
      }
    }
    save();
    meStatus = added ? `Marked ${added} characters known.` : "Nothing new to mark: they are all marked already.";
    if (left) meStatus += ` ${left} you had marked not known were left as they are.`;
    if (lastRoute === "#/me") refresh();
  }

  function eraseAll() {
    const size = state.settings.size, hideKw = state.settings.hideKw;
    state = blankState();
    state.settings.size = size;
    state.settings.hideKw = hideKw;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing stored anyway */ }
    findQuery = "";
    meStatus = "All reading data erased.";
    refresh();
    setStatus("All reading data erased.");
  }

  // ---------- character sheet ----------

  // ctx is the chapter key ("book-04:4.5") when opened from a chapter, else null.
  // mode: "m" the key of a modern word; "p" a single character in modern content
  // (its Path card when there is one); "" a character of the Analects.
  function openSheet(c, ctx, tapped, mode, fromSheet) {
    const ctxInfo = ctx ? chapterFromKey(ctx) : null;
    if (ctxInfo && !keyIsShown(ctx)) {
      const rec = chRec(ctx, true);
      const shown = mode === "m" ? surfaceOf(c) : c;
      rec.look[shown] = (rec.look[shown] || 0) + 1;
      save();
    }
    if (fromSheet && sheetCur && !sheet.hidden) sheetStack.push({ ...sheetCur, y: sheetBody.scrollTop });
    else sheetStack = [];
    if (sheet.hidden) sheetOpener = document.activeElement;
    sheetCur = { c, ctx, mode };
    paintSheet();
    sheetBody.scrollTop = 0;
    const wasHidden = sheet.hidden;
    sheet.hidden = false;
    backdrop.hidden = false;
    app.inert = true;
    tabs.inert = true;
    if (wasHidden) sheet.style.transform = "";
    document.getElementById("sheet-close").focus({ preventScroll: true });
    if (tapped) keepAboveSheet(tapped);
  }

  function paintSheet() {
    const { c, ctx, mode } = sheetCur;
    const ctxInfo = ctx ? chapterFromKey(ctx) : null;
    let kids;
    if (mode === "m") kids = modernSheet(c, ctxInfo);
    else if (mode === "p") kids = pathOrFallback(c);
    else kids = sheetContent(c, ctxInfo);
    sheetBody.replaceChildren(...kids);
    sheetBack.hidden = !sheetStack.length;
  }

  function repaintSheet() {
    if (sheet.hidden || !sheetCur) return;
    const y = sheetBody.scrollTop;
    paintSheet();
    sheetBody.scrollTop = y;
  }

  // Scroll so the tapped character sits above the sheet. The extra page padding
  // (html.sheet-open) makes room to scroll near the end of a short chapter.
  function keepAboveSheet(el) {
    document.documentElement.classList.add("sheet-open");
    const r = el.getBoundingClientRect();
    const top = window.innerHeight - sheet.offsetHeight; // final position, ignoring the rise animation
    const head = app.querySelector(".top");
    const ceil = head ? head.getBoundingClientRect().bottom : 0; // under the sticky page head
    const room = Math.min(16, top / 4);
    if (r.bottom > top - room) window.scrollBy(0, r.bottom - top + room + 8);
    else if (r.top < ceil) window.scrollBy(0, r.top - ceil - 16);
  }

  function closeSheet(restoreFocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    app.inert = false;
    tabs.inert = false;
    sheet.style.transform = "";
    sheetStack = [];
    sheetCur = null;
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

  const plecoLink = (q) => h("a", { class: "pleco", href: PLECO + encodeURIComponent(q) }, "Open in Pleco");

  function sheetContent(c, ctx, lg) {
    const found = lookup(c);
    const e = found && found.e;
    const kids = [h("div", { class: "sheet-head" },
      h("span", { class: "sheet-char", lang: lg || "zh-Hant", id: "sheet-head" }, c),
      h("div", null,
        e && e.kw ? h("p", { class: "sheet-kw" }, e.kw) : null,
        e && e.py ? h("p", { class: "sheet-py" }, e.py) : null,
        e ? h("p", { class: "sheet-kind" }, kindLabel(e, found), found.head !== c ? h("span", { lang: "zh-Hant" }, ", under " + found.head) : null) : null,
        plecoLink(c)))];

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
    // The same character on the Path, in its simplified shape.
    const simp = data.pidx[c] ? c : data.ptrad[c];
    if (data.path && simp && data.pidx[simp]) {
      kids.push(h("h3", { class: "section-label" }, "On the Path"));
      kids.push(h("div", { class: "pchars" }, pathCharRow(simp)));
    }
    if (e && e.n > 0) kids.push(h("p", { class: "count" }, `×${e.n} in the Analects`));
    if (e && e.src) kids.push(h("p", { class: "src" }, ...zhRuns("Card: " + e.src, "zh-Hant")));

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

  // One row per character: glyph, keyword, stage, known or not. Opens its Path card.
  function pathCharRow(c) {
    const n = stageOf(c);
    const m = markOf(c);
    const kw = kwOf(c);
    return h("button", { type: "button", class: "pchar" + (m === 1 ? " is-known" : ""), "data-c": c, "data-p": "1" },
      h("span", { class: "pc-g", lang: "zh-Hans" }, c),
      h("span", { class: "pc-kw" + (kw ? "" : " muted") }, kw || "no keyword yet"),
      h("span", { class: "pc-st" }, "stage " + n),
      h("span", { class: "pc-k" + (m === 1 ? " on" : m === 0 ? " no" : "") }, m === 1 ? "known" : m === 0 ? "not yet" : ""));
  }

  // The sheet for a modern word: meaning, parts, its traditional form, the Analects
  // cards its characters already have, its characters on the Path, and where else it turns up.
  function modernSheet(key, ctx) {
    const e = data.mwords[key];
    const s = surfaceOf(key);
    const kids = [h("div", { class: "sheet-head" },
      h("span", { class: "sheet-char" + ([...s].length > 1 ? " word" : ""), lang: "zh-Hans", id: "sheet-head" }, s),
      h("div", null,
        e ? h("p", { class: "sheet-kw" }, e.g) : null,
        e && e.py ? h("p", { class: "sheet-py" }, e.py) : null,
        e ? h("p", { class: "sheet-kind" }, (e.k === "grammar" ? "grammar word" : "word") + (e.card ? "" : ", no card")) : null,
        plecoLink(s)))];
    const pathRows = () => {
      if (!data.path) return;
      const cs = [...new Set([...s].filter((c) => HAN.test(c) && data.pidx[c]))];
      if (!cs.length) return;
      kids.push(h("h3", { class: "section-label" }, cs.length === 1 ? "On the Path" : "Its characters on the Path"));
      kids.push(h("div", { class: "pchars" }, cs.map(pathCharRow)));
    };
    if (!e) {
      kids.push(h("p", { class: "none" }, "No entry yet"));
      pathRows();
      return kids;
    }
    const field = (lab, text) => {
      if (text) kids.push(h("h3", { class: "section-label" }, lab), h("p", { class: "field" }, ...zhRuns(text, "zh-Hans")));
    };
    if (ctx && ctx.ch.wfw) {
      const here = [];
      for (const row of ctx.ch.wfw) for (const [w, g] of row) if (w === s && g && !here.includes(g)) here.push(g);
      if (here.length && here.join("; ") !== e.g.split(";")[0].trim()) field("In this passage", here.join("; "));
    }
    field("Parts", e.parts);
    pathRows();
    if (e.trad) kids.push(h("h3", { class: "section-label" }, "Traditional"), h("p", { class: "field" }, h("span", { lang: "zh-Hant" }, e.trad)));
    if (e.known && e.known.length) {
      kids.push(h("h3", { class: "section-label" }, "Your Analects cards"));
      kids.push(h("p", { class: "known" }, e.known.flatMap(([c, kw]) => [
        h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": c }, c),
        h("span", null, kw)])));
    }
    field(e.k === "grammar" ? "Jobs" : "Note", e.note);
    if (e.n > 0) kids.push(h("p", { class: "count" }, `×${e.n} in the modern texts`));
    if (e.src) kids.push(h("p", { class: "src" }, ...zhRuns("First met: " + e.src, "zh-Hans")));
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

  // A single modern character: its Path card, else the modern word, else the Analects card.
  function pathOrFallback(c) {
    if (data.path && data.pidx[c]) {
      const n = stageOf(c);
      if (!(n in data.stages)) {
        loadStage(n).then(() => { if (sheetCur && sheetCur.c === c && sheetCur.mode === "p") repaintSheet(); });
      }
      return pathSheet(c);
    }
    if (data.mwords[c]) return modernSheet(c, null);
    return sheetContent(c, null, "zh-Hans");
  }

  function pathSheet(c) {
    const pe = data.pent[c];
    const e = pe && pe.e;
    const n = stageOf(c);
    const st = data.path.byN[n];
    const kw = kwOf(c);
    const m = markOf(c);
    const kids = [h("div", { class: "sheet-head" },
      h("span", { class: "sheet-char path", lang: "zh-Hans", id: "sheet-head" }, c),
      h("div", null,
        kw ? h("p", { class: "sheet-kw" }, kw) : null,
        e && e.py ? h("p", { class: "sheet-py" }, e.py) : null,
        h("p", { class: "sheet-kind" }, h("a", { href: "#/path/" + n, onclick: () => closeSheet(false) }, "Stage " + n),
          pe && pe.g ? h("span", null, " · ", ...zhRuns(pe.g, "zh-Hans")) : null),
        h("a", { class: "pleco", href: PLECO + encodeURIComponent(c) + "&mode=df&hw=" + encodeURIComponent(c) }, "Open in Pleco")))];

    kids.push(h("button", {
      type: "button", class: "know", id: "know", "aria-pressed": String(m === 1),
      onclick: () => {
        setKnown(c, isKnown(c) ? 0 : 1);
        save();
        repaintSheet();
        refresh();
      },
    }, h("span", { class: "box", "aria-hidden": "true" }, m === 1 ? "✓" : ""), "I know this",
    m === 0 ? h("span", { class: "aside" }, " · marked not yet") : null));

    const field = (lab, text, cls, lg) => {
      if (text) kids.push(h("h3", { class: "section-label" }, lab), h("p", { class: "field " + (cls || "") }, ...zhRuns(text, lg || "zh-Hans")));
    };
    if (!e) {
      kids.push(h("p", { class: "none" }, !(n in data.stages) ? "Loading…"
        : st && st.file ? "This stage's card did not load." : `Stage ${n} is not written yet.`));
    } else {
      field("Parts", e.parts);
      field("Story", e.story, "story");
      if (e.words.length) {
        kids.push(h("h3", { class: "section-label" }, "Words"));
        kids.push(h("ul", { class: "pwords" }, e.words.map((w) => {
          const mk = data.mwords[w.w] ? w.w : null;
          const inner = [h("span", { class: "pw-w", lang: "zh-Hans" }, w.w), h("span", { class: "pw-py" }, w.py), h("span", { class: "pw-g" }, w.g)];
          return h("li", null, mk ? h("button", { type: "button", class: "pw", "data-c": mk, "data-m": "1" }, ...inner) : h("span", { class: "pw" }, ...inner));
        })));
      }
      field("Note", e.note);
      if (e.trad) field("Traditional", e.trad, "", "zh-Hant");
      if (e.have !== "new") {
        const ac = e.have === "analects" ? c : [...e.trad].find((t) => data.chars[t]) || [...e.trad][0] || c;
        kids.push(h("h3", { class: "section-label" }, "From your Analects cards"));
        kids.push(h("p", { class: "known" },
          data.chars[ac] ? h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": ac }, ac) : h("span", { class: "zh-big", lang: "zh-Hant" }, ac),
          h("span", null, e.akw || (data.chars[ac] && data.chars[ac].kw) || ""),
          e.have === "shape" ? h("span", { class: "aside" }, "a different shape") : null));
      }
    }
    if (!e || e.have === "new") {
      const ac = data.chars[c] ? c : null;
      if (ac) {
        kids.push(h("h3", { class: "section-label" }, "From your Analects cards"));
        kids.push(h("p", { class: "known" }, h("button", { type: "button", class: "char-btn", lang: "zh-Hant", "data-c": ac }, ac), h("span", null, data.chars[ac].kw || "")));
      }
    }
    const mw = data.mwords[c];
    if (mw) {
      kids.push(h("h3", { class: "section-label" }, "In your texts"));
      kids.push(h("button", { type: "button", class: "pchar", "data-c": c, "data-m": "1" },
        h("span", { class: "pc-g", lang: "zh-Hans" }, c),
        h("span", { class: "pc-kw" }, ...zhRuns(mw.g, "zh-Hans")),
        h("span", { class: "pc-st" }, mw.n ? "×" + mw.n : ""),
        icon("more")));
    }
    return kids;
  }

  function kindLabel(e, found) {
    if (found.word) return "word";
    return KINDS[e.k] || e.k || "";
  }

  function entryFields(e) {
    const out = [];
    const field = (lab, text, cls) => {
      if (text) out.push(h("h3", { class: "section-label" }, lab), h("p", { class: "field " + (cls || "") }, ...zhRuns(text, "zh-Hant")));
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
        h("p", null, ...zhRuns(g.g || "", "zh-Hant"))));
    }
    for (const [w, e] of Object.entries(data.words)) {
      if (w === c || !w.includes(c) || !ch.text.includes(w)) continue;
      out.push(h("div", { class: "in-ch" },
        h("span", { class: "t", lang: "zh-Hant" }, w),
        e.py ? h("span", { class: "py" }, e.py) : null,
        h("p", null, e.kw || ""),
        e.jobs ? h("p", null, ...zhRuns(e.jobs, "zh-Hant")) : null));
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
    const mode = el.dataset.m === "1" ? "m" : el.dataset.p === "1" ? "p" : "";
    openSheet(el.dataset.c, ctxEl ? ctxEl.dataset.ctx : null, el.classList.contains("h") ? el : null, mode, sheet.contains(el));
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeSheet();
    const el = ev.target.closest && ev.target.closest(".h[data-c]");
    if (el && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); el.click(); }
  });
  backdrop.addEventListener("click", () => closeSheet());
  document.getElementById("sheet-close").addEventListener("click", () => closeSheet());
  sheetBack.addEventListener("click", () => {
    const prev = sheetStack.pop();
    if (!prev) return;
    sheetCur = { c: prev.c, ctx: prev.ctx, mode: prev.mode };
    paintSheet();
    sheetBody.scrollTop = prev.y || 0;
    document.getElementById("sheet-close").focus({ preventScroll: true });
  });

  // Pull the sheet down by its grip to close it.
  (() => {
    const grip = document.getElementById("sheet-grip");
    let y0 = null, dy = 0;
    grip.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; dy = 0; sheet.classList.add("dragging"); }, { passive: true });
    grip.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    const end = () => {
      if (y0 === null) return;
      sheet.classList.remove("dragging");
      y0 = null;
      if (dy > 80) closeSheet(); else sheet.style.transform = "";
    };
    grip.addEventListener("touchend", end);
    grip.addEventListener("touchcancel", end);
  })();

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
    for (const [c, [n, kw]] of Object.entries(data.pidx)) {
      rows.push({
        head: c, path: true, modern: true, stage: n, e: { kw, n: 0 },
        hay: fold(c + " " + kw), kw: fold(kw).split(/[^a-z0-9']+/).filter(Boolean), py: [],
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
      if (score > 0) hits.push({ row, score: score + (!!row.modern === (lang === "zh-Hans") ? 2 : 0) - (row.path ? 1 : 0) });
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
      topBar({ href: "#/me", label: "Me" }, h("h1", { class: "ch-num" }, "Find")),
      input,
      h("p", { class: "hint" }, "Try a meaning, a part (\"thread ladle\") or pinyin without tones (\"ze\")."),
      list);
    paintResults(list, findQuery);
    if (!findQuery && window.matchMedia("(hover: hover)").matches) input.focus();
  }

  function paintResults(list, q) {
    const hits = search(q);
    const items = hits.slice(0, 60).map((row) => h("li", null,
      h("button", {
        type: "button", class: "result",
        "data-c": row.modern && !row.path ? row.key : row.head,
        "data-m": row.modern && !row.path ? "1" : null,
        "data-p": row.path ? "1" : null,
      },
      h("span", { class: "c", lang: row.modern ? "zh-Hans" : "zh-Hant" }, row.head),
      h("span", { class: "kw" }, row.e.kw || (row.path ? "no keyword yet" : "")),
      h("span", { class: "kind" }, row.path ? "stage " + row.stage : row.modern ? "modern" : (row.word ? "word" : (KINDS[row.e.k] || ""))))));
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

  function pathReport() {
    if (!data.path) return [];
    const P = data.path;
    const cut = state.cut || 0;
    const lines = [""];
    const known = knownCount();
    const gained = Object.entries(state.path).filter(([c, r]) => r.k === 1 && r.t > cut && data.pidx[c]).length;
    lines.push(`Path: ${num(known)} of ${num(P.total)} characters known` + (gained ? ` (${gained} marked known since the last report)` : ""));
    const touched = [];
    for (const s of P.stages) {
      if (!s.chars.some((c) => state.path[c])) continue;
      touched.push(`${s.n}: ${stageKnown(s)}/${s.size}`);
    }
    if (touched.length) lines.push("Stages: " + touched.join(" · "));
    const xs = Object.entries(state.path).filter(([, r]) => r.xt > cut)
      .sort((a, b) => stageOf(a[0]) - stageOf(b[0]) || a[1].xt - b[1].xt)
      .map(([c, r]) => c + (r.k === 1 ? " (now known)" : ""));
    if (xs.length) lines.push(`✗ in drills: ${xs.join(" ")}`);
    return lines;
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
    lines.push(...pathReport());
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
    const paintActions = (mode) => actions.replaceChildren(...reportActions(mode, paintActions));
    paintActions("");
    const buttons = [h("button", { type: "button", class: "btn primary", id: "copy", onclick: () => copyText(text, status) }, "Copy")];
    if (navigator.share) {
      buttons.push(h("button", { type: "button", class: "btn", id: "share", onclick: () => navigator.share({ text }).catch(() => {}) }, "Share"));
    }
    render(
      topBar({ href: "#/me", label: "Me" }, h("h1", { class: "ch-num" }, "Report")),
      h("p", { class: "hint" }, "Paste this into the weekly chat with Claude."),
      h("pre", { class: "report-text", id: "report", lang: "en" }, ...zhRuns(text)),
      h("div", { class: "report-buttons" }, ...buttons),
      status,
      actions);
  }

  function reportActions(mode, repaint) {
    if (mode === "sent") {
      return [h("div", { class: "confirm" },
        h("p", null, "Start a new report? Your reading marks stay. Looked-up characters for this period are cleared."),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn primary", id: "confirm-sent", onclick: markSent }, "Mark as sent"),
          h("button", { type: "button", class: "btn", onclick: () => repaint("") }, "Cancel")))];
    }
    return [h("button", { type: "button", class: "btn", id: "mark-sent", onclick: () => repaint("sent") }, "Mark report as sent")];
  }

  function markSent() {
    state.cut = Date.now();
    for (const rec of Object.values(state.ch)) rec.look = {};
    save();
    refresh();
    setStatus("Marked as sent. A new report starts now.");
  }

  function setStatus(msg) {
    const el = document.getElementById("report-status") || document.getElementById("me-status");
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
