# 📖 CoolText

**Make PDFs cool again.** Drop in a PDF, Word doc, or pasted text and turn reading into an experience.

## What it does

- **Upload anything** — PDF, Word (`.docx`), plain text, or Markdown, or just paste text. Drag & drop supported.
- **🎧 Listen** — natural read-aloud (Web Speech API) with karaoke-style live word highlighting and auto-scroll. While listening, the rest of the page dims like a cinema so only the spoken paragraph stays lit. Click any word to start from there.
- **⚡ Focus mode** — RSVP speed reading: one word at a time, anchored on its optimal recognition point, from 100 to 1000 wpm, with smart pauses at commas and sentence ends. Hit 🎧 inside focus mode and speech drives the flow — you hear and see each word in perfect sync.
- **👁 Bionic reading** — optionally bold the first ~40% of every word to give the eye fixation anchors.
- **🧬 Document DNA** — instant insights on open: reading ease, grade level, listen time, and top keywords.
- **📍 Resume** — remembers where you left off in every document, automatically.
- **Classic reader** — clean typography (serif or sans), adjustable text size, dark & light themes, reading progress bar. Confetti when you finish. 🎉
- **🔒 Private & offline** — everything is parsed in your browser. No server, no upload, no tracking. Installable as a PWA and fully usable offline.

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
