# Linq Support Copilot — Complete Assignment Documentation

**Full-stack messaging dashboard with AI lead qualification (Linq + Gemini + Next.js)**

---
1. [Loom Video Demo](https://www.loom.com/share/2a970d5875cf4908829c348d412cbf82)  
2. [Github Repo](https://github.com/Dhiraj455/LinqAI-ConversationSystem)  


## Table of contents

1. [Project title and summary](#1-project-title-and-summary)  
2. [What was built](#2-what-was-built)  
3. [Features](#3-features)  
4. [Technology stack](#4-technology-stack)  
5. [System architecture](#5-system-architecture)  
6. [Lead qualification logic](#6-lead-qualification-logic)  
7. [Repository and file structure](#7-repository-and-file-structure)  
8. [API reference](#8-api-reference)  
9. [Environment variables](#9-environment-variables)  
10. [How to run, build, and test](#10-how-to-run-build-and-test)  
11. [Security and deployment considerations](#11-security-and-deployment-considerations)  
12. [Limitations and possible extensions](#12-limitations-and-possible-extensions)  
13. [References](#13-references)  

---

## 1. Project title and summary

**Title:** *Linq Support Copilot*

**Summary:** A browser-based **support and sales inbox** for agents. Outbound messages go through the **Linq Partner API v3** (SMS, RCS, iMessage). After each **customer** message, **Google Gemini** runs a **lead qualification** pipeline: it extracts structured fields (intent, urgency, needs, budget, timeline, category) and proposes **three labeled SMS reply drafts**. The agent **always** chooses whether to send; there is **no automatic outbound** from the AI. API secrets stay on the **Next.js server** and never ship to the client.

---

## 2. What was built

| Aspect | Description |
|--------|-------------|
| **Problem** | Agents need one place to message customers over carrier channels and get intelligent, stage-aware reply suggestions without exposing API tokens in the browser. |
| **Solution** | A **Next.js 16** application with a React client UI, server **route handlers** that call Linq and Gemini, and an **in-memory lead store** keyed per browser session (and per Linq `chat_id` for webhooks). |
| **User** | One **agent** uses the web UI; one **customer** is the phone number configured in environment variables (`LINQ_TO_NUMBER`). |
| **AI role** | **Qualification** (structured extraction + three drafts per inbound turn) and optional **transcript-level** “other reply ideas” separate from the lead funnel. |

---

## 3. Features

### Messaging and UI

- **Chat timeline** — Dark-themed UI: outbound (indigo) vs inbound (grey) bubbles, timestamps, delivery status (sending / sent / failed).
- **Outbound via Linq** — Agent composes text; server calls `POST /v3/chats` (new thread) or `POST /v3/chats/{id}/messages` (existing thread).
- **Optimistic UI** — Outbound message appears immediately as `sending`, then updates to `sent` or `failed`; **Retry** on failure.
- **Trace IDs** — Linq `traceId` shown on successful sends for support and debugging.

### AI lead qualification

- **Stage machine** — `intro` → `question1` → `question2` → `done`, with extracted answers and category/escalation hints.
- **Three reply drafts** — After each customer line, three **agent→customer** SMS options (labels + text); user taps to copy/send via normal send path.
- **No auto-send** — Gemini never calls Linq to message the customer; only the agent’s action does.

### Additional AI: transcript suggestions

- **Separate feature** — “Other reply ideas from transcript” uses the **whole thread** text (different prompts from lead drafts). Invoked via `POST /api/suggest` or bundled when loading history from Linq (`POST /api/conversation/analyze`).

### Developer and demo tools

- **Simulated inbound** — Menu generates **AI customer lines** (optional intent hint) via Gemini; no SMS.
- **Test as customer** — Type a line and **Add inbound** to simulate the customer on the same machine (updates UI + lead pipeline; does not send SMS).
- **Load thread from Linq** — Pulls message history from the API, rebuilds transcript, **synthesizes or replays** lead state, optional suggestion chips.
- **Purge partner records** — Deletes messages from **Linq’s partner API** for the thread (with typed confirmation); **does not** remove messages from physical devices (per Linq behavior).

### Integrations

- **Webhook** — `POST /api/webhook` handles Linq events (e.g. `message.received`), updates lead state for real inbound SMS; still **does not** auto-reply to the customer.

---

## 4. Technology stack

| Layer | Technology |
|-------|------------|
| **Framework** | Next.js 16, App Router |
| **UI** | React 19, TypeScript |
| **Styling** | Tailwind CSS 4 |
| **Messaging** | Linq Partner API **v3** (`https://api.linqapp.com/api/partner`) |
| **AI** | Google Gemini (`generateContent`, JSON / structured output) |
| **Lead state** | In-memory `Map` in `lib/lead-store.ts` (resets on server restart; replace with DB for production persistence) |

---

## 5. System architecture

### 5.1 Text diagram (browser → server → providers)

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React client: app/page.tsx)                           │
│  • Messages, composer, lead panel, simulate / test customer     │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS (JSON)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js Route Handlers (app/api/**/route.ts)                   │
│  • /api/send          → lib/linq.ts → Linq REST                 │
│  • /api/lead/inbound  → lib/lead-engine.ts → gemini-lead + store│
│  • /api/suggest       → lib/gemini-suggest.ts                   │
│  • /api/conversation/analyze → linq + lead replay/synthesize    │
│  • /api/webhook       → processLeadInbound(chatId, …)           │
└────────────┬───────────────────────────────┬────────────────────┘
             │                               │
             ▼                               ▼
    ┌────────────────┐            ┌─────────────────────┐
    │ Linq Partner   │            │ Google Gemini API   │
    │ API (Bearer)   │            │ (API key, server)   │
    └────────────────┘            └─────────────────────┘
```

### 5.2 Outbound send flow

1. Browser `POST /api/send` with `{ text, chatId? }`.
2. Server reads `LINQ_API_TOKEN`, resolves sender/receiver E.164 from env (`lib/linq-env.ts`).
3. Server calls `createChatAndSend` or `sendMessageToChat` (`lib/linq.ts`).
4. Response returns `chatId`, `messageId`, `deliveryStatus`, `traceId`, `service` to the client.

**Invariant:** The Linq token exists only in `process.env` on the server.

### 5.3 Two different AI features (do not confuse)

| Name | When it runs | Endpoint(s) | Output |
|------|----------------|-------------|--------|
| **Lead qualification** | After each **customer** inbound line | `POST /api/lead/inbound` (and webhook uses same engine) | Updated `LeadState` + **three** labeled SMS drafts for the agent |
| **Transcript suggestions** | On demand / after sync | `POST /api/suggest`, or part of `POST /api/conversation/analyze` | **Three** generic reply chips + intent label from full transcript |

Lead drafts are tied to the **state machine**. Transcript chips are a **separate** “what could we say next?” helper.

### 5.4 Sync from Linq (`POST /api/conversation/analyze`)

1. Resolve `chatId` from `from`/`to` in env or from request body.
2. Paginate `GET /v3/chats/{chatId}/messages`.
3. Build `Agent:` / `Customer:` transcript.
4. **Lead state:** Prefer one-shot `synthesizeLeadStateFromTranscript`; on failure, **replay** each inbound through `processLeadInbound`.
5. Optionally run transcript suggestion Gemini unless `skipGemini`.

---

## 6. Lead qualification logic

### 6.1 Storage

- **`lib/lead-store.ts`** — `Map<conversationKey, LeadState>`.
- **Browser session key** — `localStorage` key `linq_lead_session` (values like `sess_…`) sent as `conversationKey`. It is **not** replaced by Linq `chatId` after sending so qualification does not reset when a chat is created.
- **Webhooks** — Use Linq `chat_id` as the key so real SMS and stored state align for that thread.

### 6.2 Stages (`LeadStage`)

1. **intro** — First customer message: intent summary + urgency → **question1**.
2. **question1** — Capture **lookingFor** → **question2**.
3. **question2** — Budget, timeline, category, escalate → **done**.
4. **done** — Follow-up / recovery reply styles for later messages.

Implementation: `lib/lead-engine.ts` (`processLeadInbound`), with Gemini helpers in `lib/gemini-lead.ts` and fallbacks if Gemini errors.

---

## 7. Repository and file structure

```
app/
  page.tsx                     Client UI (inbox, lead panel, tools)
  layout.tsx                   Root layout, metadata
  api/
    send/route.ts              POST /api/send
    simulate/route.ts          POST /api/simulate
    suggest/route.ts           POST /api/suggest
    webhook/route.ts           POST /api/webhook
    conversation/
      analyze/route.ts         POST — Linq history + lead + optional chips
      purge/route.ts           POST — partner API message deletion
    lead/
      inbound/route.ts         POST /api/lead/inbound
      reset/route.ts           POST /api/lead/reset
      state/route.ts           GET  /api/lead/state
docs/
  ASSIGNMENT_SUBMISSION.md     This document (source for full PDF)
  PROJECT_BRIEF.md             Short handout
  ARCHITECTURE.md              Architecture deep dive
  DEVELOPMENT.md               Setup and debugging
lib/
  linq.ts                      Linq REST client
  linq-env.ts                  Sender/receiver from env
  phone.ts                     E.164 normalization
  lead-types.ts                Types: LeadState, LeadStage, …
  lead-store.ts                In-memory state
  lead-engine.ts               Qualification pipeline
  gemini-lead.ts               Extraction, drafts, transcript synthesis
  gemini-suggest.ts            Transcript suggestion chips
  inbox-sse-bus.ts             SSE fan-out stub (not wired in UI)
.env.local.example             Environment template
package.json                   Scripts: dev, build, start, lint
```

---

## 8. API reference

All routes are under the Next.js app base URL (e.g. `http://localhost:3000`).

### `POST /api/send`

**Body:** `{ "text": string, "chatId"?: string }`  
**Behavior:** Creates chat if `chatId` omitted; else sends into existing chat.  
**Returns:** `success`, `chatId`, `messageId`, `deliveryStatus`, `traceId`, `service`.

### `POST /api/simulate`

**Body:** `{ "intent"?: string }` (e.g. `lead_intro`, `pricing`, `scheduling`; omit for variety)  
**Returns:** Fake inbound message object for UI + lead pipeline.

### `POST /api/suggest`

**Body:** `{ "transcript": string }`  
**Returns:** Three suggestion objects + `intent` + `source` (transcript-only; not lead funnel).

### `POST /api/lead/inbound`

**Body:** `{ "text": string, "conversationKey"?: string, "chatId"?: string, "transcript"?: string }`  
**Returns:** `replySuggestions` (three drafts), `state`, Gemini flags, optional `error`.

### `GET /api/lead/state`

**Query:** `?conversationKey=` or `?chatId=`  
**Returns:** Current `LeadState` JSON.

### `POST /api/lead/reset`

**Body:** `{ "conversationKey"?: string, "chatId"?: string }`  
**Returns:** Fresh `LeadState`.

### `POST /api/webhook`

**Body:** Linq event JSON (e.g. `message.received`).  
**Behavior:** Updates lead state for inbound text; **does not** send SMS.

### `POST /api/conversation/analyze`

**Body (optional fields):** `conversationKey`, `chatId`, `from`, `to`, `skipGemini`  
**Returns:** Messages, transcript, `chatId`, `leadState`, optional `suggestions`, `geminiError` if applicable.

### `POST /api/conversation/purge`

**Body:** `{ "confirm": "DELETE_ALL_PARTNER_MESSAGES", "chatId"?: string, "from"?: string, "to"?: string }`  
**Returns:** Counts of attempted/deleted partner records; disclaimer that phones are unchanged.

---

## 9. Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LINQ_API_TOKEN` | Yes | Bearer token for Linq Partner API |
| `LINQ_VIRTUAL_NUMBER` or `LINQ_FROM_NUMBER` | Yes | Your Linq “Send from” line, E.164 |
| `LINQ_TO_NUMBER` (or `LINQ_RECEIVER_NUMBER` / `LINQ_CUSTOMER_NUMBER`) | Yes | Customer phone, E.164 |
| `GEMINI_API_KEY` | Yes | Gemini for qualification, suggestions, simulate |
| `GEMINI_MODEL` | No | Default in code: `gemini-2.5-flash` |
| `NEXT_PUBLIC_CUSTOMER_NUMBER` | No | Display-only label in header |

Copy `.env.local.example` to `.env.local` and fill values. **Do not commit** `.env.local`.

---

## 10. How to run, build, and test

### Prerequisites

- Node.js compatible with Next.js 16  
- Linq Partner API access and E.164 numbers  
- Google AI Studio API key for Gemini  

### Commands

```bash
npm install
cp .env.local.example .env.local   # then edit
npm run dev                         # http://localhost:3000
npm run build                       # production build
npm run start                       # production server
npm run lint                        # ESLint
```

### Testing modes

| Mode | What to do |
|------|------------|
| **Solo / dev** | Agent: main composer. Customer: **Test as customer** or **simulate** menu — no second phone; inbound does not SMS. |
| **Outbound real SMS** | With env set, agent sends still go through Linq to `LINQ_TO_NUMBER`. |
| **Full E2E with live replies in UI** | Expose app (e.g. ngrok), register `POST /api/webhook` in Linq; customer texts the Linq line from their phone. |
| **Limitation** | Two browser tabs still share the same env and session model — not two independent customers without extra work. |

### Debugging

- Use **trace IDs** on sent messages for Linq support.  
- **Reset thread & state** or `POST /api/lead/reset` if qualification state is wrong.  
- Empty sync: verify chat exists for from/to pair and token can list chats.

---

## 11. Security and deployment considerations

- **Secrets:** `LINQ_API_TOKEN` and `GEMINI_API_KEY` are server-only (`process.env`).  
- **Scaling:** In-memory `lead-store` is per process; multiple instances need shared storage (Redis/DB).  
- **SSE stub:** `inbox-sse-bus.ts` is not connected to the UI; live multi-tab push would need wiring + possibly Redis pub/sub.  
- **Purge:** Partner API deletion ≠ deleting messages on user devices.

---

## 12. Limitations and possible extensions

**Current limitations**

- Message history is primarily **client-held** unless loaded from Linq; reload may lose local-only lines.  
- One configured customer number per deployment (typical demo setup).  
- Lead state lost on **server restart** (in-memory).

**Natural extensions** (from README roadmap)

1. Persist chats (SQLite/Prisma, etc.).  
2. Multiple conversations in UI.  
3. Production webhooks and delivery/read polling.  
4. Typing indicators via Linq APIs.

---

## 13. References

- Linq: [https://linqapp.com/](https://linqapp.com/) — Partner API docs: [https://apidocs.linqapp.com/](https://apidocs.linqapp.com/)  
- Google AI Studio: [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)  
- Next.js: project targets **Next.js 16** (see `package.json`)

---

### Generating this document as PDF

From the repository root:

```bash
npm run pdf:submission
```

(equivalent: `npx md-to-pdf docs/ASSIGNMENT_SUBMISSION.md` — writes `docs/ASSIGNMENT_SUBMISSION.pdf`; first run may download Chromium.)

**No CLI:** open this file in Markdown preview → **Print** → **Save as PDF**.

---

*End of assignment documentation.*
