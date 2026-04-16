const LINQ_BASE_URL = "https://api.linqapp.com/api/partner";

/** Partner API: {@link https://apidocs.linqapp.com/documentation/chats#list-all-chats} */
export interface LinqChatListItem {
  id: string;
  updated_at: string;
  handles: Array<{ handle: string; is_me?: boolean | null }>;
}

/** Partner API: {@link https://apidocs.linqapp.com/documentation/messages#get-messages-from-a-chat} */
export interface LinqThreadMessage {
  id: string;
  chat_id: string;
  is_from_me: boolean;
  created_at: string;
  parts?: Array<
    | { type: "text"; value?: string }
    | { type: "link"; value?: string }
    | { type: "media"; filename?: string }
  > | null;
}

export interface LinqMessagePart {
  type: "text" | "media" | "link";
  value?: string;
  url?: string;
}

export interface LinqSendResult {
  chatId: string;
  messageId: string;
  deliveryStatus: string;
  traceId?: string;
  service?: string;
}

export interface LinqError {
  status: number;
  code: number;
  message: string;
}

function getAuthHeaders() {
  const token = process.env.LINQ_API_TOKEN;
  if (!token) throw new Error("LINQ_API_TOKEN is not set");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/** Plain-text summary of a message's parts (for UI + transcript). */
export function formatLinqMessageBody(
  parts: LinqThreadMessage["parts"]
): string {
  if (!parts?.length) return "";
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && p.value?.trim()) chunks.push(p.value.trim());
    else if (p.type === "link" && p.value?.trim())
      chunks.push(`[link: ${p.value.trim()}]`);
    else if (p.type === "media" && p.filename?.trim())
      chunks.push(`[attachment: ${p.filename.trim()}]`);
  }
  return chunks.join(" ").trim();
}

/**
 * List chats (one page). Use `from` + `to` (E.164) to find the 1:1 thread like the sandbox.
 * @see https://apidocs.linqapp.com/documentation/chats
 */
export async function listChatsPage(params: {
  from: string;
  to: string;
  limit?: number;
  cursor?: string;
}): Promise<{ chats: LinqChatListItem[]; next_cursor: string | null }> {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    limit: String(params.limit ?? 100),
  });
  if (params.cursor) q.set("cursor", params.cursor);

  const res = await fetch(`${LINQ_BASE_URL}/v3/chats?${q.toString()}`, {
    method: "GET",
    headers: getAuthHeaders(),
  });

  const data = (await res.json()) as {
    chats?: LinqChatListItem[];
    next_cursor?: string | null;
    error?: LinqError;
  };

  if (!res.ok) {
    throw new Error(data.error?.message ?? `Linq list chats error ${res.status}`);
  }

  return {
    chats: data.chats ?? [],
    next_cursor: data.next_cursor ?? null,
  };
}

/** Walk pagination and return the chat with the latest `updated_at` for this pair. */
export async function resolveChatIdForPair(
  fromE164: string,
  toE164: string,
  maxPages = 20
): Promise<string | null> {
  let cursor: string | undefined;
  let best: { id: string; updated_at: string } | null = null;

  for (let page = 0; page < maxPages; page++) {
    const { chats, next_cursor } = await listChatsPage({
      from: fromE164,
      to: toE164,
      limit: 100,
      cursor,
    });

    for (const c of chats) {
      if (!best || c.updated_at > best.updated_at) {
        best = { id: c.id, updated_at: c.updated_at };
      }
    }

    if (!next_cursor) break;
    cursor = next_cursor;
  }

  return best?.id ?? null;
}

/**
 * All messages in a chat (paginated GET).
 * @see https://apidocs.linqapp.com/documentation/messages
 */
export async function fetchAllMessagesForChat(
  chatId: string,
  maxPages = 30
): Promise<LinqThreadMessage[]> {
  const collected: LinqThreadMessage[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);

    const res = await fetch(
      `${LINQ_BASE_URL}/v3/chats/${encodeURIComponent(chatId)}/messages?${q}`,
      { method: "GET", headers: getAuthHeaders() }
    );

    const data = (await res.json()) as {
      messages?: LinqThreadMessage[];
      next_cursor?: string | null;
      error?: LinqError;
    };

    if (!res.ok) {
      throw new Error(
        data.error?.message ?? `Linq get messages error ${res.status}`
      );
    }

    collected.push(...(data.messages ?? []));
    if (!data.next_cursor) break;
    cursor = data.next_cursor ?? undefined;
  }

  return collected.sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
}

/** One line per message for Gemini / logs (`Agent:` / `Customer:`). */
export function transcriptFromLinqMessages(
  messages: LinqThreadMessage[]
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const body = formatLinqMessageBody(m.parts);
    if (!body) continue;
    lines.push(m.is_from_me ? `Agent: ${body}` : `Customer: ${body}`);
  }
  return lines.join("\n");
}

/**
 * Removes a message from Linq’s partner API / logs only. Per Linq docs this does **not**
 * unsend or remove the message from the customer’s phone or iMessage thread.
 * @see https://apidocs.linqapp.com/documentation/messages — Delete a message from system
 */
export async function deleteMessageFromPartnerApi(messageId: string): Promise<void> {
  const res = await fetch(
    `${LINQ_BASE_URL}/v3/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", headers: getAuthHeaders() }
  );
  if (res.status === 204 || res.status === 404) return;
  const data = (await res.json().catch(() => ({}))) as { error?: LinqError };
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Linq delete message ${res.status}`);
  }
}

export interface PurgeDmThreadResult {
  chatId: string | null;
  attempted: number;
  deleted: number;
  errors: Array<{ messageId: string; message: string }>;
}

/** Deletes every message ID returned for the chat (paginated GET, then DELETE each). */
export async function purgeAllMessagesInChat(chatId: string): Promise<{
  attempted: number;
  deleted: number;
  errors: Array<{ messageId: string; message: string }>;
}> {
  const messages = await fetchAllMessagesForChat(chatId);
  const errors: Array<{ messageId: string; message: string }> = [];
  let deleted = 0;
  for (const m of messages) {
    try {
      await deleteMessageFromPartnerApi(m.id);
      deleted += 1;
    } catch (e) {
      errors.push({
        messageId: m.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { attempted: messages.length, deleted, errors };
}

/** Resolves the DM between `fromE164` and `toE164`, then purges all message records from the partner API. */
export async function purgeDmThreadFromPartnerApi(params: {
  fromE164: string;
  toE164: string;
  chatId?: string;
}): Promise<PurgeDmThreadResult> {
  const chatId =
    params.chatId?.trim() ||
    (await resolveChatIdForPair(params.fromE164, params.toE164));
  if (!chatId) {
    return { chatId: null, attempted: 0, deleted: 0, errors: [] };
  }
  const { attempted, deleted, errors } = await purgeAllMessagesInChat(chatId);
  return { chatId, attempted, deleted, errors };
}

/**
 * Create a new chat and send the first message.
 * Uses POST /v3/chats
 */
export async function createChatAndSend(
  from: string,
  to: string,
  text: string
): Promise<LinqSendResult> {
  const body = {
    from,
    to: [to],
    message: {
      parts: [{ type: "text", value: text }],
    },
  };

  const res = await fetch(`${LINQ_BASE_URL}/v3/chats`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = data as { error: LinqError; trace_id?: string };
    throw new Error(err.error?.message ?? `Linq API error ${res.status}`);
  }

  return {
    chatId: data.chat.id,
    messageId: data.chat.message.id,
    deliveryStatus: data.chat.message.delivery_status,
    traceId: data.trace_id,
    service: data.chat.service,
  };
}

/**
 * Send a message in an existing chat.
 * Uses POST /v3/chats/{chatId}/messages
 */
export async function sendMessageToChat(
  chatId: string,
  text: string
): Promise<LinqSendResult> {
  // V3 expects SendMessageToChatRequest: { message: { parts: [...] } }
  const body = {
    message: {
      parts: [{ type: "text" as const, value: text }],
    },
  };

  const res = await fetch(`${LINQ_BASE_URL}/v3/chats/${chatId}/messages`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    chat_id?: string;
    message?: { id: string; delivery_status: string; service?: string };
    trace_id?: string;
    error?: LinqError;
    success?: boolean;
  };

  if (!res.ok) {
    throw new Error(data.error?.message ?? `Linq API error ${res.status}`);
  }

  const msg = data.message;
  if (!msg?.id) {
    throw new Error("Linq returned an unexpected send response (missing message.id)");
  }

  return {
    chatId: data.chat_id ?? chatId,
    messageId: msg.id,
    deliveryStatus: msg.delivery_status,
    traceId: data.trace_id,
    service: msg.service,
  };
}
