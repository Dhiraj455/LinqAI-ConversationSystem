/**
 * In-memory fan-out for Server-Sent Events (broadcast to connected browser tabs).
 *
 * Nothing in this repository wires a route to `inboxSseSubscribe` yet; inbound today is pull-based
 * (sync from Linq) or webhook-updated server state. If you add `EventSource` in the client, call
 * `inboxSseBroadcast` from the webhook handler after `processLeadInbound`.
 * Single Node process only — use Redis pub/sub if you scale horizontally.
 */

export type InboundSsePayload =
  | { type: "connected"; at: string }
  | {
      type: "inbound";
      chatId: string;
      messageId: string;
      text: string;
      createdAt: string;
      from?: string;
      leadState?: unknown;
      replySuggestions?: unknown;
      usedGeminiReplySuggestions?: boolean;
      leadError?: string;
    };

type SendFn = (payload: InboundSsePayload | Record<string, unknown>) => void;

const clients = new Set<SendFn>();

export function inboxSseSubscribe(send: SendFn): () => void {
  clients.add(send);
  return () => {
    clients.delete(send);
  };
}

/** Returns number of clients that received the event. */
export function inboxSseBroadcast(payload: Record<string, unknown>): number {
  let n = 0;
  const dead: SendFn[] = [];
  for (const send of clients) {
    try {
      send(payload as InboundSsePayload);
      n++;
    } catch {
      dead.push(send);
    }
  }
  for (const d of dead) clients.delete(d);
  return n;
}
