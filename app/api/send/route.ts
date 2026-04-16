import { NextRequest } from "next/server";
import { createChatAndSend, sendMessageToChat } from "@/lib/linq";
import { resolveLinqReceiver, resolveLinqSender } from "@/lib/linq-env";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text, chatId } = body as { text: string; chatId?: string };

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    const from = resolveLinqSender();
    const to = resolveLinqReceiver();

    if (!from) {
      return Response.json(
        {
          error:
            "Set LINQ_FROM_NUMBER or LINQ_VIRTUAL_NUMBER to your Linq dashboard “Send from” number (E.164, e.g. +13102796264).",
        },
        { status: 500 }
      );
    }
    if (!to) {
      return Response.json(
        {
          error:
            "Set LINQ_TO_NUMBER (or LINQ_RECEIVER_NUMBER / LINQ_CUSTOMER_NUMBER) in .env.local to the recipient’s E.164 number.",
        },
        { status: 500 }
      );
    }

    let result;
    if (chatId) {
      result = await sendMessageToChat(chatId, text.trim());
    } else {
      result = await createChatAndSend(from, to, text.trim());
    }

    return Response.json({
      success: true,
      chatId: result.chatId,
      messageId: result.messageId,
      deliveryStatus: result.deliveryStatus,
      traceId: result.traceId,
      service: result.service,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
