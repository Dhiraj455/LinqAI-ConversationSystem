import { NextRequest } from "next/server";
import { processLeadInbound } from "@/lib/lead-engine";

/**
 * POST JSON: { text, conversationKey?, chatId?, transcript? }
 * Returns replySuggestions (3 agent→customer SMS options) + updated qualification state.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { text, chatId, conversationKey, transcript } = body as {
      text?: string;
      chatId?: string;
      conversationKey?: string;
      transcript?: string;
    };

    if (typeof text !== "string") {
      return Response.json({ error: "text is required (string)" }, { status: 400 });
    }

    const key =
      (typeof conversationKey === "string" && conversationKey.trim()) ||
      (typeof chatId === "string" && chatId.trim()) ||
      "default";

    const result = await processLeadInbound(
      key,
      text,
      typeof transcript === "string" ? transcript : undefined
    );

    return Response.json({
      success: true,
      replySuggestions: result.replySuggestions,
      state: result.state,
      usedGemini: result.usedGemini,
      usedGeminiReplySuggestions: result.usedGeminiReplySuggestions,
      error: result.error,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
