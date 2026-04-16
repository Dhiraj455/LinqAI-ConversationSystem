import { NextRequest } from "next/server";
import { generateReplySuggestions } from "@/lib/gemini-suggest";

/** Optional Gemini reply chips from the full transcript (not the lead-flow drafts). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { transcript } = body as { transcript?: string };

    if (!transcript || typeof transcript !== "string") {
      return Response.json(
        { error: "transcript is required (string)" },
        { status: 400 }
      );
    }

    const result = await generateReplySuggestions(transcript);
    return Response.json({
      intent: result.intent,
      suggestions: result.suggestions,
      source: "gemini",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const missingKey = message.includes("GEMINI_API_KEY");
    return Response.json(
      {
        error: message,
        intent: "",
        suggestions: [],
        source: "gemini",
      },
      { status: missingKey ? 503 : 500 }
    );
  }
}
