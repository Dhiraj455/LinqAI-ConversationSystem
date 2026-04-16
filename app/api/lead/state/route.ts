import { NextRequest } from "next/server";
import { getLeadState } from "@/lib/lead-store";

/** GET ?conversationKey= or ?chatId= — current in-memory lead qualification state. */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const key =
    searchParams.get("conversationKey")?.trim() ||
    searchParams.get("chatId")?.trim() ||
    "default";

  const state = getLeadState(key);
  return Response.json({ state });
}
