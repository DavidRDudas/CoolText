/* ============================================================
   CoolText — app.js
   Parse PDFs / Word docs / plain text, then read them three ways:
   classic reader, read-aloud with live highlighting, and RSVP
   focus mode. Everything runs client-side.
   ============================================================ */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ---------------- State ---------------- */

  const doc = {
    title: '',
    key: '',          // fingerprint for resume-position storage
    fullText: '',
    paragraphs: [],   // { start, end, isHeading }
    words: [],        // { text, start, end }
    sentenceStarts: [], // word indices that begin a sentence
  };

  const state = {
    currentWord: 0,
    wpm: 320,
    rate: 1,
    voiceURI: '',
    fontSize: 21,
    font: 'serif',
    bionic: false,
  };

  const els = {
    landing: $('#landing'),
    reader: $('#reader'),
    rsvp: $('#rsvp'),
    textContainer: $('#text-container'),
    docTitle: $('#doc-title'),
    docStats: $('#doc-stats'),
    progressBar: $('#reader-progress-bar'),
    settingsPanel: $('#settings-panel'),
    voiceSelect: $('#voice-select'),
    toast: $('#toast'),
    parseProgress: $('#parse-progress'),
    parseStatus: $('#parse-status'),
    rsvpWord: $('#rsvp-word'),
    rsvpBefore: $('.rsvp-before'),
    rsvpOrp: $('.rsvp-orp'),
    rsvpAfter: $('.rsvp-after'),
    rsvpContext: $('#rsvp-context'),
    rsvpProgressBar: $('#rsvp-progress-bar'),
    rsvpWpmLabel: $('#rsvp-wpm-label'),
  };

  /* ---------------- Preferences ---------------- */

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('cooltext-prefs') || '{}');
      Object.assign(state, saved);
    } catch { /* first visit */ }
    document.documentElement.dataset.theme =
      localStorage.getItem('cooltext-theme') ||
      (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }

  function savePrefs() {
    const { wpm, rate, voiceURI, fontSize, font } = state;
    localStorage.setItem('cooltext-prefs', JSON.stringify({ wpm, rate, voiceURI, fontSize, font }));
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cooltext-theme', next);
  }

  /* ---------------- Toast ---------------- */

  let toastTimer;
  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
  }

  /* ============================================================
     Parsing — turn any input into paragraphs of plain text
     ============================================================ */

  async function parseFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf') || file.type === 'application/pdf') return parsePdf(file);
    if (name.endsWith('.docx')) return parseDocx(file);
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown') ||
        file.type.startsWith('text/')) {
      return file.text();
    }
    if (name.endsWith('.doc')) {
      throw new Error('Legacy .doc files aren\'t supported — please save as .docx and try again.');
    }
    throw new Error('Unsupported file type. Try a PDF, .docx, .txt or .md file.');
  }

  async function parsePdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF engine is still loading — try again in a second.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pageTexts = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      els.parseStatus.textContent = `Reading page ${p} of ${pdf.numPages}…`;
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();

      // Rebuild lines from positioned glyph runs, then merge into paragraphs.
      let text = '';
      let lastY = null;
      let lastHeight = 0;
      for (const item of content.items) {
        if (!item.str) continue;
        const y = item.transform[5];
        const h = item.height || lastHeight || 10;
        if (lastY !== null) {
          const gap = Math.abs(lastY - y);
          const line = Math.min(lastHeight || h, h);        // smaller of the two line heights,
          if (gap > line * 1.5) text += '\n\n';             // so heading→body gaps still split
          else if (gap > line * 0.5) text += ' ';           // normal line wrap
        }
        text += item.str;
        if (item.hasEOL) text += ' ';
        lastY = y;
        lastHeight = h;
      }
      pageTexts.push(text);
    }
    // De-hyphenate words split across line breaks: "exam- ple" → "example"
    return pageTexts.join('\n\n').replace(/(\w)-\s+(?=[a-z])/g, '$1');
  }

  async function parseDocx(file) {
    if (!window.mammoth) throw new Error('Word engine is still loading — try again in a second.');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }

  /* ---------------- Read from a URL ---------------- */

  // Pull the readable text out of an HTML page: prefer <article>/<main>,
  // drop chrome (nav, ads, scripts), keep block-level text in order.
  function extractReadableText(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('script, style, noscript, svg, nav, header, footer, aside, form, iframe, button')
      .forEach((el) => el.remove());
    const root = parsed.querySelector('article') || parsed.querySelector('main') || parsed.body;
    if (!root) return '';
    const blocks = [...root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre')]
      .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0);
    // Nested matches (e.g. p inside blockquote) produce duplicates — drop repeats.
    const seen = new Set();
    const unique = blocks.filter((t) => !seen.has(t) && seen.add(t));
    return unique.length ? unique.join('\n\n') : root.textContent;
  }

  function extractHtmlTitle(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return parsed.querySelector('meta[property="og:title"]')?.content || parsed.title || '';
  }

  // Light markdown → plain text for the reader-service fallback.
  function markdownToPlain(md) {
    return md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links → their text
      .replace(/^#{1,6}\s+/gm, '')                   // heading markers
      .replace(/^[>*+-]\s+/gm, '')                   // quotes and bullets
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')  // emphasis
      .replace(/`{1,3}/g, '');
  }

  async function fetchFromUrl(raw) {
    let input = raw.trim();
    if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
    let url;
    try { url = new URL(input); } catch { throw new Error('That doesn\'t look like a valid URL.'); }

    // Try reading the page directly — works when the site allows cross-origin reads.
    els.parseStatus.textContent = 'Fetching the page…';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const html = await res.text();
        const text = extractReadableText(html);
        if (text.split(/\s+/).filter(Boolean).length > 30) {
          return { text, title: extractHtmlTitle(html) || url.hostname };
        }
      }
    } catch { /* blocked by CORS or unreachable — fall through */ }

    // Fallback: a public reader service fetches the page and returns clean text.
    els.parseStatus.textContent = 'Site blocks direct access — using reader service…';
    const res = await fetch('https://r.jina.ai/' + url.href, {
      signal: AbortSignal.timeout(25000),
      headers: { Accept: 'text/plain' },
    }).catch(() => null);
    if (!res || !res.ok) {
      throw new Error('Couldn\'t fetch that page — try copying the text and pasting it instead.');
    }
    const body = await res.text();
    let title = url.hostname;
    let content = body;
    const titleMatch = body.match(/^Title:\s*(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();
    const markerIdx = body.indexOf('Markdown Content:');
    if (markerIdx !== -1) content = body.slice(markerIdx + 'Markdown Content:'.length);
    return { text: markdownToPlain(content), title };
  }

  /* ---------------- Document model ---------------- */

  function buildDocument(rawText, title) {
    const paraTexts = rawText
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}|\n(?=\s*[-•*\d])/)         // blank lines or list-ish starts
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);

    if (paraTexts.length === 0) throw new Error('Couldn\'t find any readable text in that document.');

    doc.title = title;
    doc.paragraphs = [];
    doc.words = [];
    doc.sentenceStarts = [];

    let fullText = '';
    for (const p of paraTexts) {
      const start = fullText.length;
      fullText += p;
      const isHeading = p.length < 90 && !/[.:,;!?]$/.test(p) && p.split(' ').length <= 12;
      doc.paragraphs.push({ start, end: fullText.length, isHeading });
      fullText += '\n\n';
    }
    doc.fullText = fullText;

    // Cheap fingerprint so we can remember reading position per document.
    let h = 5381;
    for (let i = 0; i < fullText.length; i += 7) h = ((h * 33) ^ fullText.charCodeAt(i)) >>> 0;
    doc.key = h.toString(36) + '-' + fullText.length;

    const wordRe = /\S+/g;
    let m;
    while ((m = wordRe.exec(fullText)) !== null) {
      doc.words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    if (doc.words.length === 0) throw new Error('Couldn\'t find any readable text in that document.');

    // Sentence starts: first word, or word after sentence-ending punctuation / paragraph break.
    const paraStartSet = new Set(doc.paragraphs.map((p) => p.start));
    doc.words.forEach((w, i) => {
      if (i === 0 || paraStartSet.has(w.start) ||
          /[.!?…]["'”’)]*$/.test(doc.words[i - 1].text)) {
        doc.sentenceStarts.push(i);
      }
    });
  }

  /* ---------------- Reader rendering ---------------- */

  // Bionic reading: index to split a word so its first ~40% of letters can be bolded.
  function bionicSplit(text) {
    const letterRe = /[0-9A-Za-zÀ-ɏ]/;
    const letters = text.split('').filter((c) => letterRe.test(c)).length;
    if (letters < 2) return 0;
    const target = Math.ceil(letters * 0.4);
    let seen = 0;
    for (let i = 0; i < text.length; i++) {
      if (letterRe.test(text[i]) && ++seen === target) return i + 1;
    }
    return 0;
  }

  function renderReader() {
    els.docTitle.textContent = doc.title;
    const mins = Math.max(1, Math.round(doc.words.length / 230));
    els.docStats.textContent =
      `${doc.words.length.toLocaleString()} words · ~${mins} min read`;

    const frag = document.createDocumentFragment();
    const tocItems = [];
    let wi = 0;
    for (const para of doc.paragraphs) {
      const el = document.createElement(para.isHeading ? 'h2' : 'p');
      if (para.isHeading) {
        el.className = 'doc-heading';
        tocItems.push({ text: doc.fullText.slice(para.start, para.end), wordIdx: wi });
      }
      while (wi < doc.words.length && doc.words[wi].start < para.end) {
        const span = document.createElement('span');
        span.className = 'w';
        span.dataset.i = wi;
        const text = doc.words[wi].text;
        const split = bionicSplit(text);
        if (split > 0) {
          span.append(Object.assign(document.createElement('b'), { textContent: text.slice(0, split) }),
                      text.slice(split));
        } else {
          span.textContent = text;
        }
        el.appendChild(span);
        el.appendChild(document.createTextNode(' '));
        wi++;
      }
      frag.appendChild(el);
    }
    els.textContainer.replaceChildren(frag);
    renderToc(tocItems);
    renderInsights();
    applyReadingPrefs();
    setCurrentWord(0, false);
  }

  /* ---------------- Table of contents ---------------- */

  function renderToc(items) {
    $('#toc-btn').hidden = items.length < 2;
    $('#toc-list').replaceChildren(...items.map(({ text, wordIdx }) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.addEventListener('click', () => {
        $('#toc-panel').hidden = true;
        if (tts.speaking) tts.start(wordIdx);
        else setCurrentWord(wordIdx);
      });
      li.appendChild(btn);
      return li;
    }));
  }

  /* ---------------- Document DNA ---------------- */

  const STOPWORDS = new Set(('the a an and or but if then else when while for nor so yet of in on at to from by with' +
    ' about into over after before under above between out off up down is are was were be been being have has had do' +
    ' does did will would shall should may might must can could this that these those it its they them their there' +
    ' here he she his her him you your we our us i me my not no yes than as too very just also only more most other' +
    ' some any all each every both few many much such what which who whom whose where why how because through during' +
    ' again once against same own said says like get got make made even still back well').split(' '));

  function countSyllables(word) {
    const groups = word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  function renderInsights() {
    const el = $('#insights');
    const clean = doc.words
      .map((w) => w.text.toLowerCase().replace(/[^a-zà-ɏ'’-]/g, ''))
      .filter(Boolean);
    const sentences = Math.max(1, doc.sentenceStarts.length);
    const syllables = clean.reduce((s, w) => s + countSyllables(w), 0);
    const wordsPerSentence = doc.words.length / sentences;
    const syllablesPerWord = syllables / Math.max(1, clean.length);

    const ease = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    const easeLabel = ease >= 80 ? 'Very easy' : ease >= 60 ? 'Easy' : ease >= 50 ? 'Medium'
      : ease >= 30 ? 'Challenging' : 'Dense';
    const grade = Math.round(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59);
    const gradeLabel = grade <= 0 ? 'Grade 1' : grade > 12 ? 'College level' : 'Grade ' + grade;
    const listenMins = Math.max(1, Math.round(doc.words.length / 155));

    const freq = new Map();
    for (const w of clean) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      const base = w.replace(/[’']s$/, '');
      freq.set(base, (freq.get(base) || 0) + 1);
    }
    const keywords = [...freq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    const ICONS = {
      ease: '<svg class="icon" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
      level: '<svg class="icon" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
      listen: '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
      keywords: '<svg class="icon" viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>',
    };
    const chips = [
      ['ease', 'Reading ease', easeLabel],
      ['level', 'Level', gradeLabel],
      ['listen', 'Listen time', `~${listenMins} min`],
    ];
    if (keywords.length) chips.push(['keywords', 'Keywords', keywords.join(', ')]);

    el.replaceChildren(...chips.map(([icon, label, value]) => {
      const chip = document.createElement('span');
      chip.className = 'insight-chip';
      chip.insertAdjacentHTML('beforeend', ICONS[icon]);
      // Values derive from document content — append as text, never as HTML.
      chip.append(label + ': ', Object.assign(document.createElement('b'), { textContent: value }));
      return chip;
    }));
    el.hidden = false;
  }

  function applyReadingPrefs() {
    els.textContainer.style.setProperty('--reading-size', state.fontSize + 'px');
    els.textContainer.classList.toggle('font-sans', state.font === 'sans');
    els.textContainer.classList.toggle('bionic', state.bionic);
    $('#fontsize-val').textContent = state.fontSize + 'px';
    $('#fontsize-range').value = state.fontSize;
    $('#rate-val').textContent = state.rate.toFixed(1) + '×';
    $('#rate-range').value = state.rate;
    $('#wpm-val').textContent = state.wpm + ' wpm';
    $('#wpm-range').value = state.wpm;
    els.rsvpWpmLabel.textContent = state.wpm + ' wpm';
    $$('.segmented button').forEach((b) => {
      if (b.dataset.font) b.classList.toggle('active', b.dataset.font === state.font);
      if (b.dataset.bionic) b.classList.toggle('active', (b.dataset.bionic === 'on') === !!state.bionic);
    });
  }

  let highlightedEl = null;
  let activePara = null;
  function setCurrentWord(i, scroll = true) {
    state.currentWord = Math.max(0, Math.min(i, doc.words.length - 1));
    if (highlightedEl) highlightedEl.classList.remove('spoken');
    highlightedEl = els.textContainer.querySelector(`[data-i="${state.currentWord}"]`);
    if (highlightedEl) {
      highlightedEl.classList.add('spoken');
      if (scroll && els.rsvp.hidden) {
        highlightedEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      const para = highlightedEl.parentElement;
      if (para !== activePara) {
        if (activePara) activePara.classList.remove('active-para');
        para.classList.add('active-para');
        activePara = para;
      }
    }
    if (!els.rsvp.hidden) rsvp.show(state.currentWord);
    els.progressBar.style.width =
      ((state.currentWord / Math.max(1, doc.words.length - 1)) * 100) + '%';
    saveProgress();
  }

  /* ---------------- Resume where you left off ---------------- */

  let lastSave = 0;
  function saveProgress(force = false) {
    if (!doc.key) return;
    const now = Date.now();
    if (!force && now - lastSave < 2000) return;
    lastSave = now;
    try {
      const all = JSON.parse(localStorage.getItem('cooltext-resume') || '{}');
      all[doc.key] = { w: state.currentWord, t: now };
      const keys = Object.keys(all);
      if (keys.length > 25) {
        keys.sort((a, b) => all[a].t - all[b].t);
        delete all[keys[0]];
      }
      localStorage.setItem('cooltext-resume', JSON.stringify(all));
    } catch { /* storage full or unavailable — resume is best-effort */ }
  }

  function savedProgress() {
    try {
      return JSON.parse(localStorage.getItem('cooltext-resume') || '{}')[doc.key]?.w ?? 0;
    } catch { return 0; }
  }

  /* ============================================================
     Reading stats — words read, documents finished, active time,
     daily streak. Local-only, like everything else here.
     ============================================================ */

  const stats = {
    data: { wordsRead: 0, docsOpened: 0, docsFinished: 0, readingMs: 0, days: {} },
    saveTimer: 0,
    activeSince: 0,

    load() {
      try {
        const saved = JSON.parse(localStorage.getItem('cooltext-stats') || 'null');
        if (saved && typeof saved === 'object') Object.assign(this.data, saved);
      } catch { /* fresh start */ }
      if (!this.data.days || typeof this.data.days !== 'object') this.data.days = {};
    },

    save() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), 500);
    },

    flush() {
      clearTimeout(this.saveTimer);
      try { localStorage.setItem('cooltext-stats', JSON.stringify(this.data)); } catch { /* best-effort */ }
    },

    dayKey(date = new Date()) {
      return date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
    },

    addWords(n) {
      this.data.wordsRead += n;
      const today = this.dayKey();
      this.data.days[today] = (this.data.days[today] || 0) + n;
      const keys = Object.keys(this.data.days);
      if (keys.length > 400) {
        keys.sort();
        for (const k of keys.slice(0, keys.length - 400)) delete this.data.days[k];
      }
      this.save();
    },

    docOpened() { this.data.docsOpened++; this.save(); },
    docFinished() { this.data.docsFinished++; this.save(); },

    // Active reading time: accumulated while listening or in focus flow.
    beginActive() { if (!this.activeSince) this.activeSince = Date.now(); },
    endActive() {
      if (!this.activeSince) return;
      this.data.readingMs += Date.now() - this.activeSince;
      this.activeSince = 0;
      this.flush();
    },

    // Consecutive active days ending today (a quiet today doesn't break it yet).
    streak() {
      const DAY = 24 * 3600 * 1000;
      let cursor = new Date();
      let count = 0;
      if (!this.data.days[this.dayKey(cursor)]) cursor = new Date(cursor.getTime() - DAY);
      while (this.data.days[this.dayKey(cursor)] > 0) {
        count++;
        cursor = new Date(cursor.getTime() - DAY);
      }
      return count;
    },

    reset() {
      this.data = { wordsRead: 0, docsOpened: 0, docsFinished: 0, readingMs: 0, days: {} };
      this.flush();
    },
  };

  function formatCount(n) {
    if (n < 10000) return n.toLocaleString();
    if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function formatDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return ms > 0 ? '<1 min' : '0 min';
    if (mins < 60) return mins + ' min';
    return (mins / 60).toFixed(1).replace(/\.0$/, '') + ' h';
  }

  function renderStatsModal() {
    const d = stats.data;
    const streak = stats.streak();
    const tiles = [
      [formatCount(d.wordsRead), 'words read'],
      [String(d.docsFinished), d.docsFinished === 1 ? 'doc finished' : 'docs finished'],
      [String(d.docsOpened), d.docsOpened === 1 ? 'doc opened' : 'docs opened'],
      [formatDuration(d.readingMs), 'time reading'],
      [String(streak), streak === 1 ? 'day streak' : 'day streak'],
      [formatCount(d.days[stats.dayKey()] || 0), 'words today'],
    ];
    $('#stats-grid').replaceChildren(...tiles.map(([value, label]) => {
      const tile = document.createElement('div');
      tile.className = 'stat-tile';
      tile.append(
        Object.assign(document.createElement('span'), { className: 'stat-value', textContent: value }),
        Object.assign(document.createElement('span'), { className: 'stat-label', textContent: label }),
      );
      return tile;
    }));
    renderStatsWeek();
  }

  function renderStatsWeek() {
    const DAY = 24 * 3600 * 1000;
    const days = [];
    let max = 0;
    for (let i = 6; i >= 0; i--) {
      const date = new Date(Date.now() - i * DAY);
      const words = stats.data.days[stats.dayKey(date)] || 0;
      max = Math.max(max, words);
      days.push({ date, words });
    }
    $('#stats-week').replaceChildren(...days.map(({ date, words }, i) => {
      const col = document.createElement('div');
      col.className = 'stats-day';
      const bar = document.createElement('div');
      bar.className = 'stats-bar' + (i === 6 ? ' today' : '');
      bar.style.height = (max ? Math.max(4, (words / max) * 100) : 4) + '%';
      bar.title = words.toLocaleString() + (words === 1 ? ' word' : ' words');
      const label = document.createElement('span');
      label.className = 'stats-day-label';
      label.textContent = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()];
      col.append(bar, label);
      return col;
    }));
  }

  function finishDocument() {
    toast('Finished!');
    celebrate();
    stats.docFinished();
  }

  function sentenceBefore(wordIdx) {
    const starts = doc.sentenceStarts;
    let cur = 0;
    for (const s of starts) { if (s < wordIdx) cur = s; else break; }
    // If we're at (or 1-2 words into) a sentence start, jump to the previous one.
    if (wordIdx - cur <= 2) {
      let prev = 0;
      for (const s of starts) { if (s < cur) prev = s; else break; }
      return prev;
    }
    return cur;
  }

  function sentenceAfter(wordIdx) {
    for (const s of doc.sentenceStarts) if (s > wordIdx) return s;
    return wordIdx;
  }

  /* ============================================================
     Read-aloud engine (Web Speech API)
     Text is spoken in sentence-sized chunks — long utterances get
     silently killed by some browsers — and word boundaries are
     mapped back to global word indices for live highlighting.
     ============================================================ */

  const tts = {
    speaking: false,
    chunks: [],      // { text, absStart }
    chunkIdx: 0,

    populateVoices() {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      const list = voices.filter((v) =>
        v.lang.startsWith(navigator.language.slice(0, 2)) || v.lang.startsWith('en'));
      if (!list.length) return;
      // Prefer a local voice: network voices (e.g. Chrome's "Google …" ones)
      // never fire word-boundary events, which breaks live highlighting.
      if (!state.voiceURI) {
        const preferred = list.find((v) => v.localService && v.default) ||
          list.find((v) => v.localService) || list.find((v) => v.default) || list[0];
        state.voiceURI = preferred.voiceURI;
      }
      els.voiceSelect.replaceChildren(...list.map((v) => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.voiceURI === state.voiceURI) opt.selected = true;
        return opt;
      }));
    },

    start(fromWord) {
      if (!('speechSynthesis' in window)) {
        toast('Read-aloud isn\'t supported in this browser.', true);
        return;
      }
      this.stop();
      rsvp.pause();

      const from = doc.words[fromWord].start;
      // Chunk the remaining text on sentence boundaries.
      const rest = doc.fullText.slice(from);
      const parts = rest.split(/(?<=[.!?…]["'”’)]*)\s+|\n\n/);
      this.chunks = [];
      let offset = from;
      for (const part of parts) {
        const idx = doc.fullText.indexOf(part, offset);
        if (part.trim()) this.chunks.push({ text: part, absStart: idx });
        offset = idx + part.length;
      }
      this.chunkIdx = 0;
      this.speaking = true;
      this.lastBoundaryWord = fromWord;
      els.reader.classList.add('speaking');
      document.body.classList.add('speaking');
      stats.beginActive();
      setCurrentWord(fromWord);
      this.speakNext();
    },

    speakNext() {
      if (!this.speaking || this.chunkIdx >= this.chunks.length) {
        if (this.speaking) finishDocument();
        this.stop();
        return;
      }
      const chunk = this.chunks[this.chunkIdx];
      const utt = new SpeechSynthesisUtterance(chunk.text);
      utt.rate = state.rate;
      const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === state.voiceURI);
      if (voice) utt.voice = voice;

      this.boundarySeen = false;

      utt.onstart = () => {
        // Some voices (notably Chrome's network voices) never fire word
        // boundaries. If none arrive shortly, fall back to estimated timing.
        clearTimeout(this.graceTimer);
        if (this.boundarySupported === false) { this.startEstimator(chunk); return; }
        this.graceTimer = setTimeout(() => {
          if (this.speaking && !this.boundarySeen) {
            this.boundarySupported = false;
            this.startEstimator(chunk);
          }
        }, 450);
      };
      utt.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        this.boundarySeen = true;
        this.boundarySupported = true;
        clearTimeout(this.graceTimer);
        this.stopEstimator();
        const abs = chunk.absStart + e.charIndex;
        const wi = wordIndexAt(abs);
        if (wi < 0) return;
        setCurrentWord(wi);
        // Small forward steps are words actually heard; jumps are seeks.
        const delta = wi - this.lastBoundaryWord;
        if (delta > 0 && delta <= 5) stats.addWords(delta);
        this.lastBoundaryWord = wi;
      };
      utt.onend = () => {
        clearTimeout(this.graceTimer);
        this.stopEstimator();
        this.chunkIdx++;
        this.speakNext();
      };
      utt.onerror = (e) => {
        if (e.error === 'canceled' || e.error === 'interrupted') return;
        this.stop();
        toast('Speech stopped unexpectedly — press play to resume.', true);
      };
      speechSynthesis.speak(utt);
    },

    // Fallback highlighting: advance word by word on a timer, pacing each
    // word by its length. Resyncs to the true position at every sentence,
    // since each chunk's estimator starts from that chunk's first word.
    startEstimator(chunk) {
      this.stopEstimator();
      const from = wordIndexAt(chunk.absStart);
      const to = wordIndexAt(chunk.absStart + chunk.text.length - 1);
      if (from < 0 || to < from) return;
      const words = doc.words.slice(from, to + 1);
      const totalChars = words.reduce((sum, w) => sum + w.text.length + 1, 0);
      // ~170 wpm is a typical synthesis pace at rate 1.
      const totalMs = words.length * (60000 / (170 * state.rate));
      let i = from;
      const step = () => {
        if (!this.speaking) return;
        setCurrentWord(i);
        const delta = i - this.lastBoundaryWord;
        if (delta > 0 && delta <= 5) stats.addWords(delta);
        this.lastBoundaryWord = i;
        const dwell = totalMs * ((doc.words[i].text.length + 1) / totalChars);
        i++;
        if (i > to) return;
        this.estimTimer = setTimeout(step, dwell);
      };
      step();
    },

    stopEstimator() { clearTimeout(this.estimTimer); },

    stop() {
      this.speaking = false;
      clearTimeout(this.graceTimer);
      this.stopEstimator();
      els.reader.classList.remove('speaking');
      document.body.classList.remove('speaking');
      stats.endActive();
      speechSynthesis.cancel();
    },

    toggle() {
      if (this.speaking) this.stop();
      else this.start(state.currentWord);
    },
  };

  /* ---------------- Confetti (finished a document!) ---------------- */

  function celebrate() {
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const colors = ['#c73e1d', '#e6633a', '#d9a441', '#f2c94c', '#2a6f77'];
    const parts = Array.from({ length: 140 }, () => ({
      x: canvas.width / 2,
      y: canvas.height * 0.62,
      vx: (Math.random() - 0.5) * 15,
      vy: -Math.random() * 14 - 5,
      size: Math.random() * 7 + 4,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.3,
      color: colors[(Math.random() * colors.length) | 0],
    }));
    let frame = 0;
    (function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.35; p.vx *= 0.99; p.rot += p.vrot;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - frame / 110);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
        ctx.restore();
      }
      if (++frame < 120) requestAnimationFrame(draw);
      else canvas.remove();
    })();
  }

  // Binary search: which word contains this character offset?
  function wordIndexAt(charOffset) {
    let lo = 0, hi = doc.words.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (doc.words[mid].start <= charOffset) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  /* ============================================================
     Focus mode (RSVP) — flash one word at a time, anchored on its
     optimal recognition point so the eye never has to move.
     ============================================================ */

  const rsvp = {
    playing: false,
    timer: null,

    open(fromWord = state.currentWord) {
      tts.stop();
      els.rsvp.hidden = false;
      state.currentWord = fromWord;
      this.show(fromWord);
      this.play();
    },

    close() {
      this.pause();
      els.rsvp.hidden = true;
      setCurrentWord(state.currentWord);
    },

    play() {
      if (this.playing) return;
      this.playing = true;
      els.rsvp.classList.add('playing');
      stats.beginActive();
      this.tick();
    },

    pause() {
      this.playing = false;
      els.rsvp.classList.remove('playing');
      clearTimeout(this.timer);
      if (!tts.speaking) stats.endActive();
    },

    toggle() { this.playing ? this.pause() : this.play(); },

    tick() {
      if (!this.playing) return;
      const w = doc.words[state.currentWord];
      this.show(state.currentWord);

      if (state.currentWord >= doc.words.length - 1) {
        this.pause();
        finishDocument();
        return;
      }

      // Word timing: longer words and clause/sentence ends earn extra dwell time.
      let delay = 60000 / state.wpm;
      if (w.text.length > 7) delay *= 1.25;
      if (w.text.length > 12) delay *= 1.2;
      if (/[,;:—]["'”’)]*$/.test(w.text)) delay *= 1.6;
      if (/[.!?…]["'”’)]*$/.test(w.text)) delay *= 2.1;

      saveProgress();
      this.timer = setTimeout(() => {
        state.currentWord++;
        stats.addWords(1);
        this.tick();
      }, delay);
    },

    show(i) {
      const word = doc.words[i].text;
      // Optimal recognition point: slightly left of center.
      const clean = word.replace(/^["'“‘(]+|["'”’).,;:!?…]+$/g, '');
      const lead = word.indexOf(clean.charAt(0));
      let orp;
      const len = clean.length || word.length;
      if (len <= 1) orp = 0;
      else if (len <= 5) orp = 1;
      else if (len <= 9) orp = 2;
      else if (len <= 13) orp = 3;
      else orp = 4;
      orp += Math.max(0, lead);
      orp = Math.min(orp, word.length - 1);

      els.rsvpBefore.textContent = word.slice(0, orp);
      els.rsvpOrp.textContent = word.charAt(orp);
      els.rsvpAfter.textContent = word.slice(orp + 1);

      // Re-trigger the per-word micro animation.
      els.rsvpWord.classList.remove('tick');
      void els.rsvpWord.offsetWidth;
      els.rsvpWord.classList.add('tick');

      // Faint context line: surrounding words, current one emphasized.
      const from = Math.max(0, i - 6);
      const to = Math.min(doc.words.length, i + 7);
      els.rsvpContext.replaceChildren(
        document.createTextNode(doc.words.slice(from, i).map((w) => w.text).join(' ') + ' '),
        Object.assign(document.createElement('b'), { textContent: doc.words[i].text }),
        document.createTextNode(' ' + doc.words.slice(i + 1, to).map((w) => w.text).join(' ')),
      );

      els.rsvpProgressBar.style.width =
        ((i / Math.max(1, doc.words.length - 1)) * 100) + '%';
    },

    setWpm(wpm) {
      state.wpm = Math.max(100, Math.min(1000, wpm));
      savePrefs();
      applyReadingPrefs();
    },
  };

  /* ============================================================
     Flow control — landing → reader
     ============================================================ */

  async function openDocument(getText, title) {
    els.parseProgress.hidden = false;
    els.parseStatus.textContent = 'Reading your document…';
    try {
      const result = await getText();
      const text = typeof result === 'string' ? result : result.text;
      if (typeof result !== 'string' && result.title) title = result.title;
      buildDocument(text, title);
      const resumeAt = savedProgress();
      renderReader();
      els.landing.hidden = true;
      els.reader.hidden = false;
      window.scrollTo(0, 0);
      stats.docOpened();
      if (resumeAt > 20 && resumeAt < doc.words.length - 5) {
        setCurrentWord(resumeAt);
        toast('Picked up where you left off');
      }
    } catch (err) {
      toast(err.message || 'Something went wrong reading that document.', true);
    } finally {
      els.parseProgress.hidden = true;
    }
  }

  function handleFile(file) {
    if (!file) return;
    const title = file.name.replace(/\.[^.]+$/, '');
    openDocument(() => parseFile(file), title);
  }

  function backToLanding() {
    saveProgress(true);
    tts.stop();
    rsvp.pause();
    els.reader.hidden = true;
    els.rsvp.hidden = true;
    els.settingsPanel.hidden = true;
    $('#toc-panel').hidden = true;
    els.landing.hidden = false;
  }

  /* ---------------- Sample text ---------------- */

  const SAMPLE = `The Reading Machine

There is a particular kind of magic in a page of text. Twenty-six letters, a handful of marks, and suddenly you are standing on a ship in a storm, or inside someone else's grief, or a hundred years in the future.

But somewhere along the way, reading got buried. It got trapped in scanned PDFs with cramped margins, in reports nobody opens, in documents designed for printers that no longer exist. The words are still magic — the container went stale.

CoolText is a small attempt to fix that. Drop in a document and it becomes something you can listen to, like a podcast of itself, each word lighting up as it is spoken. Or switch to focus mode and let the text come to you: one word at a time, anchored to a fixed point, so your eyes stop sweeping lines and simply receive.

Most people read around two hundred and thirty words per minute. In focus mode, many comfortably double that — not by skimming, but because the mechanical work of moving your eyes is gone. Try nudging the speed up slowly. Four hundred words per minute sounds impossible until, suddenly, it isn't.

Reading was never supposed to be a chore. It was supposed to feel like this.`;

  /* ============================================================
     Wiring
     ============================================================ */

  function animateHeroTitle() {
    const h1 = $('#hero-title');
    const words = h1.textContent.split(' ');
    h1.replaceChildren(...words.flatMap((w, i) => {
      const span = document.createElement('span');
      span.className = 'w' + (w.toLowerCase().startsWith('cool') ? ' w-accent' : '');
      span.textContent = w;
      span.style.animationDelay = (0.08 * i) + 's';
      return i < words.length - 1 ? [span, document.createTextNode(' ')] : [span];
    }));
  }

  function init() {
    loadPrefs();
    stats.load();
    animateHeroTitle();
    applyReadingPrefs();

    // Reading stats modal
    const statsModal = $('#stats-modal');
    const closeStats = () => { statsModal.hidden = true; };
    $('#stats-btn').addEventListener('click', () => {
      renderStatsModal();
      statsModal.hidden = false;
    });
    $('#stats-close').addEventListener('click', closeStats);
    $('#stats-backdrop').addEventListener('click', closeStats);
    $('#stats-reset').addEventListener('click', () => {
      if (confirm('Reset all reading stats? This can\'t be undone.')) {
        stats.reset();
        renderStatsModal();
      }
    });

    // Theme
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#theme-toggle-2').addEventListener('click', toggleTheme);

    // Intake tabs
    $$('.intake-tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.intake-tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab);
      });
      $$('.tab-panel').forEach((p) =>
        p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
    }));

    // Upload
    const dropzone = $('#dropzone');
    const fileInput = $('#file-input');
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    ['dragover', 'dragenter'].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
    dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

    // Paste
    $('#paste-go').addEventListener('click', () => {
      const text = $('#paste-input').value.trim();
      if (!text) { toast('Paste some text first', true); return; }
      openDocument(() => Promise.resolve(text), 'Pasted text');
    });

    // From a URL
    const urlGo = $('#url-go');
    async function readFromUrl() {
      const raw = $('#url-input').value.trim();
      if (!raw) { toast('Enter a link first', true); return; }
      urlGo.disabled = true;
      urlGo.textContent = 'Fetching…';
      try {
        await openDocument(() => fetchFromUrl(raw), raw);
      } finally {
        urlGo.disabled = false;
        urlGo.textContent = 'Read it';
      }
    }
    urlGo.addEventListener('click', readFromUrl);
    $('#url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') readFromUrl();
    });

    // Sample
    $('#sample-btn').addEventListener('click', () =>
      openDocument(() => Promise.resolve(SAMPLE), 'The Reading Machine'));

    // Reader chrome
    const tocPanel = $('#toc-panel');
    $('#back-btn').addEventListener('click', backToLanding);
    $('#settings-btn').addEventListener('click', () => {
      tocPanel.hidden = true;
      els.settingsPanel.hidden = !els.settingsPanel.hidden;
    });
    $('#toc-btn').addEventListener('click', () => {
      els.settingsPanel.hidden = true;
      tocPanel.hidden = !tocPanel.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!els.settingsPanel.hidden &&
          !els.settingsPanel.contains(e.target) &&
          !$('#settings-btn').contains(e.target)) {
        els.settingsPanel.hidden = true;
      }
      if (!tocPanel.hidden &&
          !tocPanel.contains(e.target) &&
          !$('#toc-btn').contains(e.target)) {
        tocPanel.hidden = true;
      }
    });

    // Click a word to jump there
    els.textContainer.addEventListener('click', (e) => {
      const span = e.target.closest('.w');
      if (!span) return;
      const i = Number(span.dataset.i);
      const wasSpeaking = tts.speaking;
      setCurrentWord(i, false);
      if (wasSpeaking) tts.start(i);
    });

    // Dock
    $('#listen-btn').addEventListener('click', () => tts.toggle());
    $('#focus-btn').addEventListener('click', () => rsvp.open());
    $('#skip-back').addEventListener('click', () => skipSentence(-1));
    $('#skip-fwd').addEventListener('click', () => skipSentence(1));

    function skipSentence(dir) {
      const target = dir < 0
        ? sentenceBefore(state.currentWord)
        : sentenceAfter(state.currentWord);
      if (tts.speaking) tts.start(target);
      else setCurrentWord(target);
    }

    // Settings
    $('#fontsize-range').addEventListener('input', (e) => {
      state.fontSize = Number(e.target.value);
      savePrefs(); applyReadingPrefs();
    });
    $('#rate-range').addEventListener('input', (e) => {
      state.rate = Number(e.target.value);
      savePrefs(); applyReadingPrefs();
    });
    $('#wpm-range').addEventListener('input', (e) => rsvp.setWpm(Number(e.target.value)));
    $$('.segmented button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.font) state.font = b.dataset.font;
      if (b.dataset.bionic) state.bionic = b.dataset.bionic === 'on';
      savePrefs(); applyReadingPrefs();
    }));
    els.voiceSelect.addEventListener('change', () => {
      state.voiceURI = els.voiceSelect.value;
      savePrefs();
      if (tts.speaking) tts.start(state.currentWord);
    });

    // RSVP overlay
    $('#rsvp-close').addEventListener('click', () => rsvp.close());
    $('#rsvp-toggle').addEventListener('click', () => rsvp.toggle());
    $('#rsvp-slower').addEventListener('click', () => rsvp.setWpm(state.wpm - 20));
    $('#rsvp-faster').addEventListener('click', () => rsvp.setWpm(state.wpm + 20));
    $('#rsvp-back').addEventListener('click', () => skipSentence(-1));
    $('#rsvp-fwd').addEventListener('click', () => skipSentence(1));
    // Listen in sync with the flow: speech boundaries drive the flashing word.
    $('#rsvp-listen').addEventListener('click', () => {
      if (tts.speaking) { tts.stop(); return; }
      rsvp.pause();
      tts.start(state.currentWord);
    });
    // Tap the stage to play/pause — the natural gesture on touch screens.
    $('.rsvp-stage').addEventListener('click', () => {
      if (tts.speaking) tts.stop();
      else rsvp.toggle();
    });
    $('.rsvp-progress').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      state.currentWord = Math.round(frac * (doc.words.length - 1));
      rsvp.show(state.currentWord);
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;

      if (!statsModal.hidden) {
        if (e.key === 'Escape') closeStats();
        return;
      }

      if (!els.rsvp.hidden) {
        if (e.key === ' ') {
          e.preventDefault();
          if (tts.speaking) tts.stop();
          else rsvp.toggle();
        }
        else if (e.key === 'Escape') rsvp.close();
        else if (e.key === 'ArrowLeft') skipSentence(-1);
        else if (e.key === 'ArrowRight') skipSentence(1);
        else if (e.key === 'ArrowUp') { e.preventDefault(); rsvp.setWpm(state.wpm + 20); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); rsvp.setWpm(state.wpm - 20); }
        return;
      }

      if (!els.reader.hidden) {
        if (e.key === ' ') { e.preventDefault(); tts.toggle(); }
        else if (e.key === 'f' || e.key === 'F') rsvp.open();
        else if (e.key === 'ArrowLeft') skipSentence(-1);
        else if (e.key === 'ArrowRight') skipSentence(1);
        else if (e.key === 'Escape') { els.settingsPanel.hidden = true; tocPanel.hidden = true; }
      }
    });

    // Voices load asynchronously in most browsers.
    if ('speechSynthesis' in window) {
      tts.populateVoices();
      speechSynthesis.addEventListener('voiceschanged', () => tts.populateVoices());
    }

    // Stop speech when leaving the page; remember position and flush stats.
    window.addEventListener('beforeunload', () => {
      saveProgress(true);
      stats.endActive();
      stats.flush();
      speechSynthesis?.cancel();
    });

    // Installable + offline.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* http or unsupported */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
