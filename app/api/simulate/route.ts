import { NextRequest } from "next/server";
import { resolveLinqReceiver } from "@/lib/linq-env";

interface SimulatedInbound {
  intent: string;
  text: string;
}

async function generateInboundWithGemini(intentHint?: string): Promise<SimulatedInbound> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const marker = Math.random().toString(36).slice(2, 8);

  const prompt = `Generate ONE realistic inbound customer message for a support/sales SMS conversation.

Context:
- The product is a messaging API platform (iMessage, RCS, SMS).
- This is a customer texting a support/sales rep.
- Keep it natural and concise (max 180 chars).
- Do not include emojis.

Intent hint: ${intentHint?.trim() || "any useful intent"}
Variation marker: ${marker}

Return ONLY valid JSON:
{"intent":"...","text":"..."}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.95,
        topP: 0.95,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${raw.slice(0, 300)}`);
  }

  const envelope = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = envelope.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty simulation response");
  }

  const parsed = JSON.parse(text) as Partial<SimulatedInbound>;
  if (!parsed.text || typeof parsed.text !== "string") {
    throw new Error("Gemini simulation response missing text");
  }

  return {
    intent: (parsed.intent ?? intentHint ?? "general").trim() || "general",
    text: parsed.text.trim(),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { intent } = body as { intent?: string };

    const customerNumber = resolveLinqReceiver() ?? "+10000000000";
    const scenario = await generateInboundWithGemini(intent);

    return Response.json({
      success: true,
      message: {
        id: `sim_${Date.now()}`,
        from: customerNumber,
        text: scenario.text,
        intent: scenario.intent,
        timestamp: new Date().toISOString(),
        simulated: true,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const missingKey = message.includes("GEMINI_API_KEY");
    return Response.json({ error: message }, { status: missingKey ? 503 : 500 });
  }
}
