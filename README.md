# Linq Support Copilot

A full-stack support/sales inbox dashboard built with **Next.js 16** and the **Linq Partner API v3**.

## Documentation

| Doc | Contents |
|-----|----------|
| This README | Overview, env vars, API examples, testing modes |
| [docs/ASSIGNMENT_SUBMISSION.md](docs/ASSIGNMENT_SUBMISSION.md) | **Full assignment doc** — everything in one place (generate PDF with `npx md-to-pdf docs/ASSIGNMENT_SUBMISSION.md`) |
| [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) | Short one-page handout (export to PDF from preview or `md-to-pdf`) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data flow, lead state machine, how routes fit together |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, scripts, debugging |

## What it does

- **Chat UI** — dark-themed message timeline with outbound (indigo) and inbound (grey) bubbles, timestamps, and delivery status.
- **Outbound messaging** — agent types a reply and it's sent via Linq (iMessage / RCS / SMS) through a secure backend route. The API token never touches the browser.
- **Optimistic UI** — message appears immediately with a `sending` status, then updates to `sent` or `failed` once the backend responds.
- **Retry on failure** — a Retry link appears on any failed message.
- **Lead qualification** — after each **customer** line, Gemini updates stage/intent/budget/etc. and proposes **three agent→customer SMS drafts**; you tap one to send via Linq (no auto-send).
- **Transcript suggestions** — optional **Other reply ideas from transcript** calls Gemini on the whole thread for extra reply chips (separate from the lead flow).
- **Simulated inbound (AI-generated)** — the ↙ menu asks Gemini to generate realistic customer lines (optionally intent-guided), so each simulation is dynamic instead of hardcoded.
- **Test as customer** — type any line in **Test as customer** and click **Add inbound** to play the customer role on the same machine (no second phone).
- **Webhook endpoint** — `POST /api/webhook` updates the same lead state as `/api/lead/inbound` (does not send SMS; agent still picks a draft and uses `/api/send`).
- **Trace IDs** — every sent message displays the Linq trace ID for debugging.

## Architecture

```
Browser (Next.js Client Component)
        │
        ▼  POST /api/send  { text, chatId? }
Next.js Route Handler  ──►  Linq API  POST /v3/chats  (or /v3/chats/{id}/messages)
        │
        ▼  returns { chatId, messageId, deliveryStatus, traceId, service }
Browser updates message status
```

The token stays server-side at all times.

## Quick start

```bash
# 1. Clone / enter the project
cd linq_ai

# 2. Install (already done if you used create-next-app)
npm install

# 3. Set up environment variables
cp .env.local.example .env.local
# edit .env.local with your Linq token and phone numbers

# 4. Run
npm run dev
# → http://localhost:3000
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LINQ_API_TOKEN` | ✅ | Your Linq Partner API bearer token |
| `LINQ_VIRTUAL_NUMBER` or `LINQ_FROM_NUMBER` | ✅ | Same as dashboard **Send from** (your Linq line), E.164; either name works |
| `LINQ_TO_NUMBER` | ✅ | Recipient in E.164; aliases `LINQ_RECEIVER_NUMBER`, `LINQ_CUSTOMER_NUMBER` |
| `GEMINI_API_KEY` | ✅ | [Google AI Studio](https://aistudio.google.com/apikey) key for reply suggestions |
| `GEMINI_MODEL` | optional | Gemini model id (default `gemini-2.5-flash` in code) |
| `NEXT_PUBLIC_CUSTOMER_NUMBER` | optional | Display-only label shown in the chat header |

## File structure

```
app/
  page.tsx                     ← Client chat UI + lead panel
  api/
    send/route.ts              ← POST /api/send → Linq outbound
    simulate/route.ts          ← POST /api/simulate → Gemini fake inbound line
    suggest/route.ts           ← POST /api/suggest → transcript reply chips only
    conversation/
      analyze/route.ts         ← POST — load Linq thread, sync lead state, optional chips
      purge/route.ts           ← POST — delete partner API message records (not phones)
    lead/
      inbound/route.ts         ← POST /api/lead/inbound → qualification + 3 drafts
      reset/route.ts           ← POST /api/lead/reset
      state/route.ts           ← GET  /api/lead/state
    webhook/route.ts           ← POST /api/webhook — Linq inbound events
docs/
  ARCHITECTURE.md              ← Deep dive for contributors
  DEVELOPMENT.md               ← Setup and debugging
lib/
  linq.ts                      ← Linq REST client (chats, messages, send, purge)
  linq-env.ts                  ← Sender/receiver from env
  phone.ts                     ← E.164 normalization
  lead-types.ts                ← LeadStage, LeadState, …
  lead-store.ts                ← In-memory Map per conversation key
  lead-engine.ts               ← processLeadInbound + replay
  gemini-lead.ts               ← Structured extraction, drafts, transcript synthesis
  gemini-suggest.ts            ← Transcript-only suggestion chips
  inbox-sse-bus.ts             ← In-memory SSE fan-out (stub; not used by UI yet)
```

## API routes

### `POST /api/send`
```json
{ "text": "Hi there!", "chatId": "optional-existing-chat-uuid" }
```
Creates a new Linq chat if `chatId` is omitted; otherwise sends into the existing chat.

### `POST /api/simulate`
```json
{ "intent": "pricing" }
```
Returns a fake inbound message. Intents include `lead_intro`, `lead_warm`, `lead_hot`, `lead_cold`, `pricing`, `scheduling`, and others—omit `intent` for a random scenario.

### `POST /api/suggest`
```json
{ "transcript": "Customer: hi\nAgent: Hello! How can I help?" }
```
Returns 3 Gemini-generated suggested replies plus a short `intent` label (optional; separate from the lead-flow drafts).

### `POST /api/lead/inbound`
```json
{ "text": "Hi, we are interested…", "conversationKey": "sess_abc", "transcript": "Customer: …\nAgent: …" }
```
Returns `replySuggestions` (three agent→customer SMS options) and `state` (stage, extracted fields). Use the same `conversationKey` or Linq `chatId` across turns.

### `POST /api/webhook`
Receive real-time events from Linq. Register `https://your-domain/api/webhook` in the Linq dashboard.

### `POST /api/conversation/analyze`
Loads messages for the configured Linq from/to pair (or a given `chatId`), rebuilds the transcript, updates lead state (synthesize or replay), and can return transcript suggestion chips. Used by **Load thread from Linq** in the UI.

Body (all optional unless noted): `conversationKey`, `chatId`, `from`, `to`, `skipGemini` (boolean).

### `POST /api/conversation/purge`
Deletes **Linq partner API** records for messages in the thread (requires `confirm: "DELETE_ALL_PARTNER_MESSAGES"`). Does not remove messages from phones—see route handler comments.

## Testing: one person vs two people

This app has **one agent UI** and **one Linq thread** per session (the customer is the phone in `LINQ_TO_NUMBER`). There is no second “login” for the customer.

### Solo on one computer (recommended for day-to-day dev)

1. **You = agent** — use the main text box; messages go out through Linq to `LINQ_TO_NUMBER`.
2. **You = customer (UI only)** — use **Test as customer** → **Add inbound**. That only updates the browser; it does **not** send SMS. The lead-flow reply chips update from the latest turn (passing transcript for better Gemini wording).
3. **Preset customer lines** — use the **↙** menu for canned inbound scenarios.

Outbound still hits Linq, so the phone in `LINQ_TO_NUMBER` can receive real texts while you drive the conversation from the UI.

### Two real people (proper end-to-end)

1. **Agent** — uses the web app.
2. **Customer** — uses their normal **Messages / SMS** app on the phone configured as `LINQ_TO_NUMBER`. They text **your Linq “Send from” number** and read your replies there.
3. **Showing their replies inside this UI** — Linq must call your **`POST /api/webhook`** when a message arrives. For local dev, expose the app with something like [ngrok](https://ngrok.com/) and register `https://<your-subdomain>.ngrok.app/api/webhook` in the Linq dashboard. Until that is wired, customer replies only appear on the phone, not in this chat timeline.

### Two browsers is not two customers

Opening the app twice still uses the **same** env numbers and **same** in-memory chat per tab unless you add multi-chat persistence—so it does not simulate two separate customers.

## Suggested next steps

1. **Persist messages** — store chats in SQLite/Prisma or a JSON file so history survives page reloads.
2. **Multiple conversations** — sidebar with 3–5 contacts each linked to a Linq chat ID.
3. **Real webhooks** — register `/api/webhook` in the Linq dashboard for true real-time inbound messages.
4. **Typing indicators** — call `POST /v3/chats/{chatId}/typing` when the agent starts typing.
5. **Delivery status polling** — poll `GET /v3/messages/{messageId}` to surface `delivered`/`read` states.
