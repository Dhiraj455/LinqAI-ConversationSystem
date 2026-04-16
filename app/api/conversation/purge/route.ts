import { NextRequest } from "next/server";
import { purgeDmThreadFromPartnerApi } from "@/lib/linq";
import { resolveLinqReceiver, resolveLinqSender } from "@/lib/linq-env";
import { normalizeE164 } from "@/lib/phone";

const CONFIRM_PHRASE = "DELETE_ALL_PARTNER_MESSAGES";

/**
 * POST JSON: { confirm: "DELETE_ALL_PARTNER_MESSAGES", chatId?, from?, to? }
 *
 * Calls Linq `DELETE /v3/messages/{id}` for every message in the resolved chat.
 * This clears Linq’s API/system copy only — it does not remove messages from devices.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { confirm, chatId: bodyChatId, from: rawFrom, to: rawTo } = body as {
      confirm?: string;
      chatId?: string;
      from?: string;
      to?: string;
    };

    if (confirm !== CONFIRM_PHRASE) {
      return Response.json(
        {
          error: `Set confirm to the exact string "${CONFIRM_PHRASE}" to proceed.`,
        },
        { status: 400 }
      );
    }

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
            "Set LINQ_FROM_NUMBER / LINQ_VIRTUAL_NUMBER and LINQ_TO_NUMBER (or pass from, to).",
        },
        { status: 400 }
      );
    }

    const chatId =
      typeof bodyChatId === "string" && bodyChatId.trim()
        ? bodyChatId.trim()
        : undefined;

    const result = await purgeDmThreadFromPartnerApi({
      fromE164: from,
      toE164: to,
      chatId,
    });

    return Response.json({
      success: true,
      disclaimer:
        "Messages were removed from Linq’s partner API only; customer phones are unchanged (per Linq docs).",
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const missingKey = message.includes("LINQ_API_TOKEN");
    return Response.json(
      { success: false, error: message },
      { status: missingKey ? 503 : 500 }
    );
  }
}
