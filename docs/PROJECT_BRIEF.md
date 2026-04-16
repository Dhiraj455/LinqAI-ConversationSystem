# Linq Support Copilot

## What you built

An internal **support and sales inbox** web app that connects to **Linq** (iMessage, RCS, SMS) so an agent can chat with a customer from the browser. **Google Gemini** qualifies leads after each customer message: it extracts intent, budget, timeline, and urgency, and proposes **three SMS reply drafts** for the agent to send—nothing auto-sends without a human click. The stack is **Next.js** on the server so API tokens never reach the browser.

## Features

- **Outbound messaging** — Send replies through Linq with optimistic UI, delivery status, trace IDs, and retry on failure.
- **AI lead qualification** — Stage-based funnel (intro → two questions → done) with extracted fields and category/escalation hints.
- **Reply drafts** — Three labeled agent→customer options after each inbound line; agent picks one to send.
- **Transcript suggestions** — Optional separate “other reply ideas” chips from the full thread.
- **Dev / demo tools** — Simulated inbound lines (Gemini), “Test as customer” without SMS, sync thread from Linq API, optional webhook for real inbound events.
- **Thread cleanup** — Purge Linq partner API message records for the pair (does not delete from phones).

## Tech used

| Area | Technology |
|------|------------|
| Framework | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Messaging API | Linq Partner API v3 |
| AI | Google Gemini (generateContent, structured JSON) |
| State | In-memory lead store per session (dev); extensible to DB |

## How to run / test it

**Run locally**

1. Install dependencies: `npm install`
2. Copy `.env.local.example` to `.env.local` and set `LINQ_API_TOKEN`, sender/receiver E.164 numbers, and `GEMINI_API_KEY`
3. Start the app: `npm run dev` → open `http://localhost:3000`

**Test without two phones**

- Use **Test as customer** or the **simulate** menu for inbound lines (no SMS).
- Use the main composer as the **agent**; outbound still uses Linq if env is set.

**Test end-to-end**

- Register `POST /api/webhook` in the Linq dashboard (e.g. via ngrok for local dev) so customer replies appear in the app timeline.

**Other commands**

- `npm run build` — production build  
- `npm run lint` — ESLint  

---

*For architecture details see [ARCHITECTURE.md](./ARCHITECTURE.md).*

### Export as PDF

1. **From the editor** — Open this file, use **Markdown preview**, then **Print** (Ctrl+P) → **Save as PDF** / **Microsoft Print to PDF**.
2. **CLI** — From the repo root: `npx md-to-pdf docs/PROJECT_BRIEF.md` (writes `docs/PROJECT_BRIEF.pdf`; first run may download Chromium).
