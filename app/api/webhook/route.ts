import { NextRequest } from "next/server";
import { processLeadInbound } from "@/lib/lead-engine";

/**
 * Linq inbound webhook: advances lead state (same logic as POST /api/lead/inbound).
 * Does not send SMS — agent uses the dashboard and /api/send after picking a suggestion.
 */
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const { event, data } = payload as {
      event: string;
      data: {
        message?: {
          id: string;
          parts: Array<{ type: string; value?: string }>;
          from_handle?: { handle: string };
          chat_id?: string;
        };
      };
    };

    if (event === "message.received" && data?.message) {
      const msg = data.message;
      const textPart = msg.parts.find((p) => p.type === "text");
      const text = textPart?.value?.trim() ?? "";
      const chatId = msg.chat_id;

      console.log(
        `[webhook] inbound from ${msg.from_handle?.handle ?? "unknown"}: "${textPart?.value}"`
      );

      if (text && chatId) {
        try {
          await processLeadInbound(chatId, text, `Customer: ${text}`);
          console.log(`[webhook] lead state updated chat=${chatId}`);
        } catch (e) {
          console.error("[webhook] lead qualification failed:", e);
        }
      }
    }

    return Response.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 400 });
  }
}
