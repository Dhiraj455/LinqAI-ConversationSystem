/**
 * Optional **transcript-level** reply chips: three short agent replies + an `intent` label.
 * Used by `POST /api/suggest` and by `POST /api/conversation/analyze` after loading a Linq thread.
 * Independent from lead-stage extraction in `gemini-lead.ts`.
 */
export interface GeminiSuggestion {
  label: string;
  text: string;
}

export interface GeminiSuggestResult {
  intent: string;
  suggestions: GeminiSuggestion[];
}

function stripJsonFence(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
  }
  return t;
}

function defaultModel() {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

/** First top-level `{ ... }` with string-aware brace matching (avoids wrong `}` from lastIndexOf). */
function sliceBalancedObject(s: string): string | null {
  const cleaned = stripJsonFence(s).trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/** Best-effort when JSON was truncated mid-string: pull intent + complete {label,text} pairs. */
function salvageFromPartialJson(raw: string): GeminiSuggestResult | null {
  const intentM = /"intent"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const intent = intentM?.[1]?.replace(/\\"/g, '"') ?? "Suggested";

  const suggestions: GeminiSuggestion[] = [];
  const pairRe =
    /\{\s*"label"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(raw)) !== null) {
    const label = m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
    const text = m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
    if (label && text) suggestions.push({ label, text });
    if (suggestions.length >= 3) break;
  }

  if (suggestions.length === 0) return null;
  return { intent, suggestions: suggestions.slice(0, 3) };
}

function collectTextParts(
  parts: Array<{ text?: string }> | undefined
): string {
  if (!parts?.length) return "";
  return parts.map((p) => p.text ?? "").join("");
}

/** Schema for Gemini JSON / structured output (Partner REST). */
const SUGGEST_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      description: "Very short topic (2–5 words).",
    },
    suggestions: {
      type: "ARRAY",
      description: "Exactly 3 reply options for the agent.",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "OBJECT",
        properties: {
          label: {
            type: "STRING",
            description: "Short button label, max 40 characters.",
          },
          text: {
            type: "STRING",
            description: "Full SMS reply, max 220 characters, no raw line breaks.",
          },
        },
        required: ["label", "text"],
      },
    },
  },
  required: ["intent", "suggestions"],
};

function parseSuggestPayload(partText: string): GeminiSuggestResult {
  const balanced = sliceBalancedObject(partText);
  const toParse = balanced ?? stripJsonFence(partText).trim();

  let parsed: { intent?: string; suggestions?: GeminiSuggestion[] };
  try {
    parsed = JSON.parse(toParse) as typeof parsed;
  } catch {
    const salvaged = salvageFromPartialJson(partText);
    if (salvaged) return salvaged;
    throw new Error(
      `Could not parse Gemini JSON. Raw (truncated): ${partText.slice(0, 220)}`
    );
  }

  const suggestions = (parsed.suggestions ?? [])
    .filter(
      (s) =>
        s &&
        typeof s.label === "string" &&
        typeof s.text === "string" &&
        s.label.trim() &&
        s.text.trim()
    )
    .slice(0, 3);

  if (suggestions.length === 0) {
    const salvaged = salvageFromPartialJson(partText);
    if (salvaged) return salvaged;
    throw new Error("Gemini returned no usable suggestions");
  }

  return {
    intent: (parsed.intent ?? "Suggested").trim() || "Suggested",
    suggestions,
  };
}

async function callGeminiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  useStructuredJson: boolean
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const generationConfig: Record<string, unknown> = {
    temperature: 0.85,
    topP: 0.95,
    maxOutputTokens: 8192,
  };

  if (useStructuredJson) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = SUGGEST_RESPONSE_SCHEMA;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  const rawText = await res.text();

  let envelope: {
    error?: { code?: number; message?: string; status?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };

  try {
    envelope = JSON.parse(rawText) as typeof envelope;
  } catch {
    throw new Error(
      `Gemini response was not JSON (HTTP ${res.status}): ${rawText.slice(0, 280)}`
    );
  }

  if (!res.ok) {
    const msg =
      envelope.error?.message ??
      rawText.slice(0, 400) ??
      `HTTP ${res.status}`;
    throw new Error(`Gemini API ${res.status}: ${msg}`);
  }

  if (envelope.error?.message) {
    throw new Error(envelope.error.message);
  }

  const block = envelope.promptFeedback?.blockReason;
  if (block) {
    throw new Error(`Gemini blocked the prompt (${block})`);
  }

  const candidate = envelope.candidates?.[0];
  const finish = candidate?.finishReason;
  const partText = collectTextParts(candidate?.content?.parts);

  if (!partText.trim()) {
    throw new Error(
      finish && finish !== "STOP"
        ? `Gemini returned no text (finishReason: ${finish})`
        : "Gemini returned no text — try GEMINI_MODEL=gemini-1.5-flash or check API key / quota"
    );
  }

  return partText;
}

/**
 * Ask Gemini for 3 agent reply options given the recent transcript.
 */
export async function generateReplySuggestions(
  transcript: string
): Promise<GeminiSuggestResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = defaultModel();
  const body = transcript.trim() || "(empty — agent just opened the thread)";
  const marker = Math.random().toString(36).slice(2, 8);

  const prompt = `You help a support/sales agent replying over iMessage/SMS.

Given this conversation transcript, propose exactly 3 distinct, professional replies the agent could send next.

Strict rules:
- Each "text" must be at most 220 characters (SMS-friendly). No line breaks inside "text" or "label".
- Each "label" must be at most 40 characters (button UI).
- Do not use double-quote characters inside label or text; use apostrophes if needed.
- If the customer wrote in another language, reply in that language.
- For very short customer messages ("hello", "ok"), still give 3 helpful follow-ups.
- Make the 3 options intentionally different:
  1) Clarifying question
  2) Helpful/actionable next step
  3) Confident close or CTA
- Avoid generic repetitive wording across options.
- Keep tone human, concise, and directly useful for the customer.

Transcript:
"""
${body}
"""

Variation marker: ${marker}`;

  let partText: string;
  try {
    partText = await callGeminiGenerate(apiKey, model, prompt, true);
  } catch (e1) {
    const msg = e1 instanceof Error ? e1.message : String(e1);
    if (/401|403|API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
      throw e1;
    }
    partText = await callGeminiGenerate(apiKey, model, prompt, false);
  }

  return parseSuggestPayload(partText);
}
