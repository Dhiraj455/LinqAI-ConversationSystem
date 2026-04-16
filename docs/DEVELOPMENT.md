# Development

## Prerequisites

- Node.js compatible with Next.js 16 (see `package.json`).
- A [Linq](https://linqapp.com/) Partner API token and sandbox/production numbers in E.164.
- A [Google AI Studio](https://aistudio.google.com/apikey) API key for Gemini.

## Setup

```bash
cd linq_ai
npm install
cp .env.local.example .env.local
# Edit .env.local — see table below
npm run dev
```

Open `http://localhost:3000`.

## Environment variables

Copy from `.env.local.example` in the repo root. Minimal set:

| Variable | Required | Notes |
|----------|----------|--------|
| `LINQ_API_TOKEN` | Yes | Bearer token for Partner API |
| `LINQ_VIRTUAL_NUMBER` or `LINQ_FROM_NUMBER` | Yes | Your Linq line (E.164) |
| `LINQ_TO_NUMBER` | Yes | Customer device (E.164); aliases `LINQ_RECEIVER_NUMBER`, `LINQ_CUSTOMER_NUMBER` |
| `GEMINI_API_KEY` | Yes | For qualification + suggestions + simulate |
| `GEMINI_MODEL` | No | Default in code: `gemini-2.5-flash` |
| `NEXT_PUBLIC_CUSTOMER_NUMBER` | No | Display-only label in the header |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Run production server |
| `npm run lint` | ESLint |

## Debugging tips

- **Trace IDs:** Successful sends show Linq `traceId` on outbound bubbles—use for support with Linq.
- **Lead state stuck:** Use **Reset thread & state** or `POST /api/lead/reset` with your `conversationKey`.
- **Empty thread after sync:** No chat yet for the from/to pair, or token cannot list chats—check env numbers and API errors in the terminal.
- **Webhook locally:** Expose the app (e.g. ngrok) and register `https://…/api/webhook` in the Linq dashboard.

## Where to read next

- [ARCHITECTURE.md](./ARCHITECTURE.md) — data flows, state machine, API roles
- [README.md](../README.md) — product overview and route cheat sheet
