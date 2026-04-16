import { NextRequest } from "next/server";
import {
  fetchAllMessagesForChat,
  formatLinqMessageBody,
  resolveChatIdForPair,
  transcriptFromLinqMessages,
  type LinqThreadMessage,
} from "@/lib/linq";
import { resolveLinqReceiver, resolveLinqSender } from "@/lib/linq-env";
import { replayLeadQualificationFromThread } from "@/lib/lead-engine";
import { setLeadState } from "@/lib/lead-store";
import { initialLeadState, type LeadState } from "@/lib/lead-types";
import { synthesizeLeadStateFromTranscript } from "@/lib/gemini-lead";
import { generateReplySuggestions, type GeminiSuggestion } from "@/lib/gemini-suggest";
import { normalizeE164 } from "@/lib/phone";

const MAX_TRANSCRIPT_CHARS = 28_000;

function trimForModel(transcript: string): string {
  const t = transcript.trim();
  if (t.length <= MAX_TRANSCRIPT_CHARS) return t;
  return t.slice(-MAX_TRANSCRIPT_CHARS);
}

function toUiMessages(messages: LinqThreadMessage[]) {
  return messages.map((m) => {
    const text = formatLinqMessageBody(m.parts) || "(no text)";
    return {
      id: m.id,
      createdAt: m.created_at,
      direction: m.is_from_me ? ("outbound" as const) : ("inbound" as const),
      text,
    };
  });
}

async function resolveLeadStateAfterSync(params: {
  conversationKey?: string;
  transcript: string;
  uiMessages: ReturnType<typeof toUiMessages>;
}): Promise<{ leadState: LeadState; leadStateSource: "synthesized" | "replayed" | "initial" }> {
  const { conversationKey, transcript, uiMessages } = params;
  const replayThread = uiMessages.map((m) => ({
    direction: m.direction,
    text: m.text,
  }));

  const persist = (state: LeadState) => {
    if (conversationKey) setLeadState(conversationKey, state);
  };

  if (!transcript.trim()) {
    const fresh = initialLeadState();
    persist(fresh);
    return { leadState: fresh, leadStateSource: "initial" };
  }

  try {
    const leadState = await synthesizeLeadStateFromTranscript(transcript);
    persist(leadState);
    return { leadState, leadStateSource: "synthesized" };
  } catch (e) {
    console.warn("[conversation/analyze] synthesizeLeadState failed:", e);
    if (conversationKey) {
      try {
        const replayed = await replayLeadQualificationFromThread(
          conversationKey,
          replayThread
        );
        return { leadState: replayed.state, leadStateSource: "replayed" };
      } catch (e2) {
        console.warn("[conversation/analyze] replayLeadQualification failed:", e2);
        const fresh = initialLeadState();
        persist(fresh);
        return { leadState: fresh, leadStateSource: "initial" };
      }
    }
    return { leadState: initialLeadState(), leadStateSource: "initial" };
  }
}

/**
 * Loads the Linq thread (`from` + `to` list chats → messages), infers lead qualification
 * from the full transcript (stage, intent, answers, category, escalate, urgency), optional
 * reply chips, and persists lead state when `conversationKey` is sent.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      from: rawFrom,
      to: rawTo,
      chatId: bodyChatId,
      skipGemini,
      conversationKey: rawConversationKey,
    } = body as {
      from?: string;
      to?: string;
      chatId?: string;
      skipGemini?: boolean;
      conversationKey?: string;
    };

    const conversationKey =
      typeof rawConversationKey === "string" && rawConversationKey.trim()
        ? rawConversationKey.trim()
        : undefined;

    const from =
      normalizeE164(typeof rawFrom === "string" ? rawFrom.trim() : "") ??
      resolveLinqSender();
    const to =
      normalizeE164(typeof rawTo === "string" ? rawTo.trim() : "") ??
      resolveLinqReceiver();

    if (!from || !to) {
      return Response.json(
        {
          error:
            "Set LINQ_FROM_NUMBER / LINQ_VIRTUAL_NUMBER and LINQ_TO_NUMBER (or pass from, to in JSON).",
        },
        { status: 400 }
      );
    }

    const chatId =
      typeof bodyChatId === "string" && bodyChatId.trim()
        ? bodyChatId.trim()
        : await resolveChatIdForPair(from, to);

    if (!chatId) {
      const { leadState, leadStateSource } = await resolveLeadStateAfterSync({
        conversationKey,
        transcript: "",
        uiMessages: [],
      });
      return Response.json({
        empty: true,
        chatId: null,
        messageCount: 0,
        messages: [] as ReturnType<typeof toUiMessages>,
        transcript: "",
        intent: "",
        suggestions: [] as GeminiSuggestion[],
        source: "",
        leadState,
        leadStateSource,
      });
    }

    const linqMessages = await fetchAllMessagesForChat(chatId);
    const transcript = transcriptFromLinqMessages(linqMessages).trim();
    const uiMessages = toUiMessages(linqMessages);

    const { leadState, leadStateSource } = await resolveLeadStateAfterSync({
      conversationKey,
      transcript,
      uiMessages,
    });

    if (!transcript) {
      return Response.json({
        empty: true,
        chatId,
        messageCount: linqMessages.length,
        messages: uiMessages,
        transcript: "",
        intent: "",
        suggestions: [] as GeminiSuggestion[],
        source: "",
        leadState,
        leadStateSource,
      });
    }

    if (skipGemini) {
      return Response.json({
        empty: false,
        chatId,
        messageCount: linqMessages.length,
        messages: uiMessages,
        transcript,
        intent: "",
        suggestions: [] as GeminiSuggestion[],
        source: "",
        leadState,
        leadStateSource,
      });
    }

    try {
      const gemini = await generateReplySuggestions(trimForModel(transcript));
      return Response.json({
        empty: false,
        chatId,
        messageCount: linqMessages.length,
        messages: uiMessages,
        transcript,
        intent: gemini.intent,
        suggestions: gemini.suggestions,
        source: "gemini",
        leadState,
        leadStateSource,
      });
    } catch (geminiErr) {
      const geminiMessage =
        geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      return Response.json({
        empty: false,
        chatId,
        messageCount: linqMessages.length,
        messages: uiMessages,
        transcript,
        intent: "",
        suggestions: [] as GeminiSuggestion[],
        source: "",
        geminiError: geminiMessage,
        leadState,
        leadStateSource,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const missingKey = message.includes("LINQ_API_TOKEN");
    return Response.json(
      {
        error: message,
        empty: true,
        transcript: "",
        intent: "",
        suggestions: [],
        leadState: initialLeadState(),
        leadStateSource: "initial" as const,
      },
      { status: missingKey ? 503 : 500 }
    );
  }
}
