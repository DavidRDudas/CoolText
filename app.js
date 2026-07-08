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
    let wi = 0;
    for (const para of doc.paragraphs) {
      const el = document.createElement(para.isHeading ? 'h2' : 'p');
      if (para.isHeading) el.className = 'doc-heading';
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
    renderInsights();
    applyReadingPrefs();
    setCurrentWord(0, false);
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

    const chips = [
      ['🧠', 'Reading ease', easeLabel],
      ['🎓', 'Level', gradeLabel],
      ['🎧', 'Listen time', `~${listenMins} min`],
    ];
    if (keywords.length) chips.push(['🔑', 'Keywords', keywords.join(', ')]);

    el.replaceChildren(...chips.map(([icon, label, value]) => {
      const chip = document.createElement('span');
      chip.className = 'insight-chip';
      chip.append(icon + ' ' + label + ': ',
        Object.assign(document.createElement('b'), { textContent: value }));
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
      els.voiceSelect.replaceChildren(...voices
        .filter((v) => v.lang.startsWith(navigator.language.slice(0, 2)) || v.lang.startsWith('en'))
        .map((v) => {
          const opt = document.createElement('option');
          opt.value = v.voiceURI;
          opt.textContent = `${v.name} (${v.lang})`;
          if (v.voiceURI === state.voiceURI || (!state.voiceURI && v.default)) opt.selected = true;
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
      els.reader.classList.add('speaking');
      document.body.classList.add('speaking');
      setCurrentWord(fromWord);
      this.speakNext();
    },

    speakNext() {
      if (!this.speaking || this.chunkIdx >= this.chunks.length) {
        if (this.speaking) { toast('Finished! 🎉'); celebrate(); }
        this.stop();
        return;
      }
      const chunk = this.chunks[this.chunkIdx];
      const utt = new SpeechSynthesisUtterance(chunk.text);
      utt.rate = state.rate;
      const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === state.voiceURI);
      if (voice) utt.voice = voice;

      utt.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        const abs = chunk.absStart + e.charIndex;
        const wi = wordIndexAt(abs);
        if (wi >= 0) setCurrentWord(wi);
      };
      utt.onend = () => { this.chunkIdx++; this.speakNext(); };
      utt.onerror = (e) => {
        if (e.error === 'canceled' || e.error === 'interrupted') return;
        this.stop();
        toast('Speech stopped unexpectedly — press play to resume.', true);
      };
      speechSynthesis.speak(utt);
    },

    stop() {
      this.speaking = false;
      els.reader.classList.remove('speaking');
      document.body.classList.remove('speaking');
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
    const colors = ['#7c6cff', '#00d4d8', '#ff7a59', '#e4589b', '#ffd166'];
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
      this.tick();
    },

    pause() {
      this.playing = false;
      els.rsvp.classList.remove('playing');
      clearTimeout(this.timer);
    },

    toggle() { this.playing ? this.pause() : this.play(); },

    tick() {
      if (!this.playing) return;
      const w = doc.words[state.currentWord];
      this.show(state.currentWord);

      if (state.currentWord >= doc.words.length - 1) {
        this.pause();
        toast('Finished! 🎉');
        celebrate();
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
      const text = await getText();
      buildDocument(text, title);
      const resumeAt = savedProgress();
      renderReader();
      els.landing.hidden = true;
      els.reader.hidden = false;
      window.scrollTo(0, 0);
      if (resumeAt > 20 && resumeAt < doc.words.length - 5) {
        setCurrentWord(resumeAt);
        toast('Picked up where you left off 📍');
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
    animateHeroTitle();
    applyReadingPrefs();

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
      if (!text) { toast('Paste some text first ✍️', true); return; }
      openDocument(() => Promise.resolve(text), 'Pasted text');
    });

    // Sample
    $('#sample-btn').addEventListener('click', () =>
      openDocument(() => Promise.resolve(SAMPLE), 'The Reading Machine'));

    // Reader chrome
    $('#back-btn').addEventListener('click', backToLanding);
    $('#settings-btn').addEventListener('click', () => {
      els.settingsPanel.hidden = !els.settingsPanel.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!els.settingsPanel.hidden &&
          !els.settingsPanel.contains(e.target) &&
          !$('#settings-btn').contains(e.target)) {
        els.settingsPanel.hidden = true;
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
    $('.rsvp-progress').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      state.currentWord = Math.round(frac * (doc.words.length - 1));
      rsvp.show(state.currentWord);
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;

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
        else if (e.key === 'Escape') els.settingsPanel.hidden = true;
      }
    });

    // Voices load asynchronously in most browsers.
    if ('speechSynthesis' in window) {
      tts.populateVoices();
      speechSynthesis.addEventListener('voiceschanged', () => tts.populateVoices());
    }

    // Stop speech when leaving the page; remember the reading position.
    window.addEventListener('beforeunload', () => {
      saveProgress(true);
      speechSynthesis?.cancel();
    });

    // Installable + offline.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* http or unsupported */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
