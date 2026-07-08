# CoolText

**Make PDFs cool again.** Drop in a PDF, Word doc, or pasted text and turn reading into an experience.

## What it does

- **Upload anything** — PDF, Word (`.docx`), plain text, or Markdown, or just paste text. Drag & drop supported.
- **Read from a URL** — paste a link and CoolText pulls the readable article text out of the page (direct fetch when the site allows it, with a public reader-service fallback for sites that block cross-origin access).
- **Listen** — natural read-aloud (Web Speech API) with karaoke-style live word highlighting and auto-scroll. While listening, the rest of the page dims like a cinema so only the spoken paragraph stays lit. Click any word to start from there.
- **Focus mode** — RSVP speed reading: one word at a time, anchored on its optimal recognition point, from 100 to 1000 wpm, with smart pauses at commas and sentence ends. Start read-aloud inside focus mode and speech drives the flow — you hear and see each word in perfect sync.
- **Bionic reading** — optionally bold the first ~40% of every word to give the eye fixation anchors.
- **Document DNA** — instant insights on open: reading ease, grade level, listen time, and top keywords.
- **Table of contents** — auto-built from detected headings for quick navigation in long documents.
- **Library** — every document you open is saved locally (IndexedDB); continue any of them from the landing page with progress bars.
- **Quote cards** — select any passage and share it as a beautifully typeset PNG.
- **Daily goal** — set a words-per-day target, watch the ring fill, get confetti when you hit it.
- **Resume** — remembers where you left off in every document, automatically.
- **Reading stats** — words read, docs opened and finished, active reading time, daily streak, words today, and a 7-day bar chart, all tracked locally (bar-chart button on the landing page).
- **Classic reader** — clean typography (serif or sans), adjustable text size, dark & light themes, reading progress bar. Confetti when you finish.
- **Private & offline** — everything is parsed in your browser. No server, no upload, no tracking. Installable as a PWA and fully usable offline.

## Running it

It's a fully static site — no build step, no dependencies to install.

```bash
# any static file server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Or deploy the repo as-is to GitHub Pages, Netlify, Vercel, etc.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `space` | Play / pause (listen or focus mode) |
| `F` | Enter focus mode |
| `←` / `→` | Back / forward one sentence |
| `↑` / `↓` | Speed up / slow down (focus mode) |
| `esc` | Exit focus mode / close settings |

## How it's built

Vanilla HTML/CSS/JS, three files:

- `index.html` — landing page, reader, and focus-mode overlay
- `style.css` — dark-first theming with CSS custom properties
- `app.js` — document parsing, reader rendering, speech engine, RSVP engine, insights
- `sw.js` + `manifest.json` — offline cache and PWA install
- `vendor/` — pdf.js 3.11.174 and mammoth.js 1.6.0, vendored so the site is fully self-contained

Parsing uses [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs (with paragraph reconstruction and de-hyphenation) and [mammoth.js](https://github.com/mwilliamson/mammoth.js) for `.docx`. Read-aloud uses the browser's built-in `speechSynthesis`, chunked by sentence for reliability, with `onboundary` events mapped back to word positions for live highlighting.
