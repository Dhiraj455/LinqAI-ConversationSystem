import { NextRequest } from "next/server";
import { resetLeadState } from "@/lib/lead-store";

/** Clears qualification state for `conversationKey` / `chatId` and returns fresh `LeadState`. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { conversationKey, chatId } = body as {
      conversationKey?: string;
      chatId?: string;
    };

    const key =
      (typeof conversationKey === "string" && conversationKey.trim()) ||
      (typeof chatId === "string" && chatId.trim()) ||
      "default";

    const state = resetLeadState(key);
    return Response.json({ success: true, state });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
