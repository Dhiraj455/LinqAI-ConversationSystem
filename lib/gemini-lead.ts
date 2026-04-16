/**
 * Gemini integration for the **lead qualification** product path.
 *
 * - **Per-message extraction** — `extractIntro` / `extractAfterQ1` / `extractFinal` return JSON
 *   via structured `generateContent` (see `callGeminiStructured`).
 * - **Three agent→customer SMS drafts** — `generateLeadAgentReplySuggestions` (stage-aware prompts).
 * - **Bulk sync** — `synthesizeLeadStateFromTranscript` rebuilds `LeadState` from a full thread when
 *   loading history (`POST /api/conversation/analyze`), avoiding replay when synthesis succeeds.
 *
 * Transcript-only “other reply ideas” live in `gemini-suggest.ts`, not here.
 */
import type {
  LeadAnswers,
  LeadCategory,
  LeadReplySuggestion,
  LeadStage,
  LeadState,
} from "@/lib/lead-types";

// --- shared JSON helpers ----------------------------------------------------

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
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return cleaned.slice(start, i + 1); }
  }
  return null;
}

function defaultModel() {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

function collectTextParts(parts: Array<{ text?: string }> | undefined): string {
  if (!parts?.length) return "";
  return parts.map((p) => p.text ?? "").join("");
}

function parseJson<T>(partText: string): T {
  const balanced = sliceBalancedObject(partText) ?? stripJsonFence(partText).trim();
  return JSON.parse(balanced) as T;
}

// --- extraction (structured fields) ----------------------------------------

export interface IntroExtraction {
  intentSummary: string;
  urgency: "high" | "medium" | "low";
}

export interface MidExtraction extends IntroExtraction {
  lookingFor: string;
}

export interface FinalExtraction extends MidExtraction {
  budget: string;
  timeline: string;
  category: LeadCategory;
  escalate: boolean;
  reason: string;
}

async function callGeminiStructured(
  prompt: string,
  responseSchema: Record<string, unknown>
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const model = defaultModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema,
      },
    }),
  });

  const rawText = await res.text();
  let envelope: {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  try {
    envelope = JSON.parse(rawText) as typeof envelope;
  } catch {
    throw new Error(`Gemini response was not JSON (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(envelope.error?.message ?? rawText.slice(0, 400) ?? `HTTP ${res.status}`);
  const block = envelope.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked the prompt (${block})`);
  const partText = collectTextParts(envelope.candidates?.[0]?.content?.parts);
  if (!partText.trim()) throw new Error("Gemini returned no text");
  return partText;
}

const ENUM_URGENCY = { type: "STRING", enum: ["high", "medium", "low"] };

const SCHEMA_INTRO = {
  type: "OBJECT",
  properties: {
    intentSummary: { type: "STRING", description: "One short phrase: what the lead wants." },
    urgency: { ...ENUM_URGENCY, description: "How soon they seem to need a solution." },
  },
  required: ["intentSummary", "urgency"],
};

const SCHEMA_Q1 = {
  type: "OBJECT",
  properties: {
    intentSummary: { type: "STRING" },
    urgency: ENUM_URGENCY,
    lookingFor: { type: "STRING", description: "What they are looking for / problem / use case." },
  },
  required: ["intentSummary", "urgency", "lookingFor"],
};

const SCHEMA_FINAL = {
  type: "OBJECT",
  properties: {
    intentSummary: { type: "STRING" },
    urgency: ENUM_URGENCY,
    lookingFor: { type: "STRING" },
    budget: { type: "STRING", description: "Budget signal: amount, range, or 'unknown'." },
    timeline: { type: "STRING", description: "When they want to start or decide." },
    category: {
      type: "STRING",
      enum: ["high", "medium", "low"],
      description: "high = clear buying intent; medium = interested but vague; low = browsing.",
    },
    escalate: { type: "BOOLEAN", description: "True if a human should follow up soon." },
    reason: { type: "STRING", description: "One sentence internal rationale (not sent to customer)." },
  },
  required: ["intentSummary", "urgency", "lookingFor", "budget", "timeline", "category", "escalate", "reason"],
};

export async function extractIntro(customerMessage: string): Promise<IntroExtraction> {
  const prompt = `You analyze SMS leads for a B2B product. Extract a short intent summary and urgency from the customer's message only.

Customer message:
"""
${customerMessage.slice(0, 2000)}
"""`;
  const raw = await callGeminiStructured(prompt, SCHEMA_INTRO);
  return parseJson<IntroExtraction>(raw);
}

export async function extractAfterQ1(
  customerMessage: string,
  prior: LeadAnswers & { intentSummary?: string }
): Promise<MidExtraction> {
  const prompt = `You analyze SMS leads. Extract from their latest message what they are looking for.

Prior context:
- intentSummary: ${prior.intentSummary ?? "(none)"}
- lookingFor so far: ${prior.lookingFor ?? "(none)"}

Latest customer message:
"""
${customerMessage.slice(0, 2000)}
"""`;
  const raw = await callGeminiStructured(prompt, SCHEMA_Q1);
  return parseJson<MidExtraction>(raw);
}

export async function extractFinal(
  customerMessage: string,
  transcript: string,
  stage: LeadStage
): Promise<FinalExtraction> {
  const prompt = `You qualify SMS leads for a B2B SaaS product. Read the full transcript and latest message.

Classification rules:
- high: strong buying signals, specific timeline, budget mentioned, clear use case.
- medium: real interest but vague budget/timeline or needs education.
- low: tire-kicking, no budget, "just looking", very far future or poor fit.

Transcript:
"""
${transcript.slice(0, 4000)}
"""

Latest customer message (stage ${stage}):
"""
${customerMessage.slice(0, 2000)}
"""`;
  const raw = await callGeminiStructured(prompt, SCHEMA_FINAL);
  return parseJson<FinalExtraction>(raw);
}

const SCHEMA_SYNC_FROM_THREAD = {
  type: "OBJECT",
  properties: {
    stage: {
      type: "STRING",
      enum: ["intro", "question1", "question2", "done"],
      description:
        "Pipeline position from the whole thread: intro=mostly greetings/no clear ask; question1=interest but thin use-case; question2=needs fairly clear, budget/timeline weak; done=qualified enough to hand off.",
    },
    intentSummary: {
      type: "STRING",
      description: "One concise phrase: what the lead wants across the thread.",
    },
    urgency: ENUM_URGENCY,
    lookingFor: {
      type: "STRING",
      description: "Problem, product area, or use case in plain language.",
    },
    budget: {
      type: "STRING",
      description: "Budget signal, range, or 'Unknown' if never stated.",
    },
    timeline: {
      type: "STRING",
      description: "When they want to start, decide, or go live — or 'Unknown'.",
    },
    category: {
      type: "STRING",
      enum: ["high", "medium", "low"],
      description:
        "high=strong buying signals and concrete next steps; medium=interested but fuzzy; low=browsing or poor fit.",
    },
    escalate: {
      type: "BOOLEAN",
      description: "True if a human should follow up soon.",
    },
  },
  required: [
    "stage",
    "intentSummary",
    "urgency",
    "lookingFor",
    "budget",
    "timeline",
    "category",
    "escalate",
  ],
};

function coerceLeadStage(raw: string): LeadStage {
  if (raw === "intro" || raw === "question1" || raw === "question2" || raw === "done") {
    return raw;
  }
  return "question2";
}

function coerceUrgency(raw: string): "high" | "medium" | "low" {
  if (raw === "high" || raw === "low" || raw === "medium") return raw;
  return "medium";
}

function coerceCategory(raw: string): LeadCategory {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

/**
 * One-shot qualification from a full Agent/Customer transcript (e.g. after syncing from Linq).
 */
export async function synthesizeLeadStateFromTranscript(
  transcript: string
): Promise<LeadState> {
  const body = transcript.trim().slice(0, 24_000);
  const prompt = `You analyze a complete sales/support SMS thread. Lines are prefixed Agent: (your employer's rep) or Customer:.

Infer a single lead-qualification snapshot from **the entire transcript**, not only the last message.

Stage rubric:
- intro: mostly greetings, emoji, or no concrete business need yet.
- question1: they show interest but what they need or their situation is still thin or unclear.
- question2: needs and use case are reasonably clear, but budget, timeline, or decision timing are missing or fuzzy.
- done: enough is captured for handoff (budget + timeline discussed, or explicit demo/booking/pricing agreement, or strong commit language).

Category rubric:
- high: strong buying signals, concrete timeline or budget, clear next step.
- medium: real interest but vague money or timing.
- low: browsing, far future, no fit, or mostly one-word replies with no substance.

Use "Unknown" only for budget or timeline when the customer never hinted at them.

Transcript:
"""
${body}
"""`;

  const raw = await callGeminiStructured(prompt, SCHEMA_SYNC_FROM_THREAD);
  const p = parseJson<{
    stage: string;
    intentSummary: string;
    urgency: string;
    lookingFor: string;
    budget: string;
    timeline: string;
    category: string;
    escalate: boolean;
  }>(raw);

  return {
    stage: coerceLeadStage(p.stage),
    answers: {
      lookingFor: p.lookingFor?.trim() || undefined,
      budget: p.budget?.trim() || undefined,
      timeline: p.timeline?.trim() || undefined,
    },
    intentSummary: p.intentSummary?.trim() || undefined,
    urgency: coerceUrgency(p.urgency),
    category: coerceCategory(p.category),
    escalate: Boolean(p.escalate),
    updatedAt: new Date().toISOString(),
  };
}

// --- reply suggestions (3 SMS options, no hardcoded canonical) --------------

export type LeadReplySuggestionSource = "gemini" | "fallback";

/**
 * What the agent should be doing at each stage — passed to Gemini as context,
 * not used to hardcode the reply text itself.
 */
const STAGE_PURPOSE: Record<string, string> = {
  intro:
    "The customer just reached out. Warmly acknowledge them and ask what they are looking for or what problem they want to solve.",
  question1:
    "You know the customer is interested. Your goal is to understand their specific use case, needs, or the problem they want to solve.",
  question2:
    "You know what they need. Now move the conversation forward: ask about their budget range and when they want to get started or go live.",
  done:
    "You have collected intent, budget, and timeline. Wrap up: either invite them to a call (if high intent) or share resources and leave the door open.",
  done_followup:
    "The conversation has concluded. Thank them warmly and let them know someone will follow up if needed.",
  empty:
    "No customer message yet. Send a warm, open-ended greeting to start the conversation.",
  error_recovery:
    "Something went wrong in the flow. Send a friendly, open-ended message to gently restart.",
};

const SUGGESTIONS_SCHEMA = {
  type: "OBJECT",
  properties: {
    suggestions: {
      type: "ARRAY",
      description: "Exactly 3 outbound SMS messages from the agent to the customer.",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING", description: "Short button label, max 40 chars." },
          text: { type: "STRING", description: "Full SMS the agent sends, max 220 chars, no line breaks." },
        },
        required: ["label", "text"],
      },
    },
  },
  required: ["suggestions"],
};

export interface ExtractedLeadContext {
  intentSummary?: string;
  lookingFor?: string;
  budget?: string;
  timeline?: string;
  category?: LeadCategory;
  escalate?: boolean;
}

async function fetchSuggestionsFromGemini(
  url: string,
  prompt: string,
  useSchema: boolean
): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.75,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
  };
  if (useSchema) {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
    (body.generationConfig as Record<string, unknown>).responseSchema = SUGGESTIONS_SCHEMA;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let envelope: {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  try {
    envelope = JSON.parse(rawText) as typeof envelope;
  } catch {
    throw new Error(`Gemini response was not JSON (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = envelope.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const block = envelope.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked (${block})`);

  const partText = collectTextParts(envelope.candidates?.[0]?.content?.parts);
  if (!partText.trim()) throw new Error("Gemini returned empty text");
  return partText;
}

function parseSuggestionsList(partText: string): LeadReplySuggestion[] {
  const balanced = sliceBalancedObject(partText) ?? stripJsonFence(partText).trim();
  const parsed = JSON.parse(balanced) as { suggestions?: LeadReplySuggestion[] };
  return (parsed.suggestions ?? [])
    .filter(
      (s) =>
        s &&
        typeof s.label === "string" &&
        typeof s.text === "string" &&
        s.label.trim().length > 0 &&
        s.text.trim().length >= 10
    )
    .slice(0, 3)
    .map((s) => ({
      label: s.label.trim().slice(0, 40),
      text: s.text.trim().replace(/\s+/g, " ").slice(0, 220),
    }));
}

export async function generateLeadAgentReplySuggestions(params: {
  transcript: string;
  stage: LeadStage | "empty" | "done_followup" | "error_recovery";
  extractedContext?: ExtractedLeadContext;
}): Promise<{ suggestions: LeadReplySuggestion[]; source: LeadReplySuggestionSource }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error("[gemini-lead] GEMINI_API_KEY is not set — no suggestions");
    return { suggestions: [], source: "fallback" };
  }

  const model = defaultModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const ctx = params.extractedContext;
  const contextLines: string[] = [];
  if (ctx?.intentSummary) contextLines.push(`Customer intent: ${ctx.intentSummary}`);
  if (ctx?.lookingFor)    contextLines.push(`What they need: ${ctx.lookingFor}`);
  if (ctx?.budget)        contextLines.push(`Budget signal: ${ctx.budget}`);
  if (ctx?.timeline)      contextLines.push(`Timeline: ${ctx.timeline}`);
  if (ctx?.category)      contextLines.push(`Lead quality: ${ctx.category}`);
  if (ctx?.escalate !== undefined) contextLines.push(`Needs immediate follow-up: ${ctx.escalate}`);

  const contextBlock = contextLines.length
    ? `\nExtracted context (use to personalise the reply):\n${contextLines.join("\n")}\n`
    : "";

  const stagePurpose = STAGE_PURPOSE[params.stage] ?? "Continue the conversation naturally.";
  const marker = Math.random().toString(36).slice(2, 8);

  const prompt = `You write SMS replies for a human sales/support agent texting a potential customer.

Stage: ${params.stage}
Goal at this stage: ${stagePurpose}
${contextBlock}
Conversation so far:
"""
${params.transcript.trim().slice(0, 3500) || "(no prior messages)"}
"""

Write exactly 3 reply options the agent can send next. Make each option clearly different:
1. Direct and to the point
2. Warm and empathetic
3. Brief (shortest possible while still complete)

Strict rules:
- Write ONLY as the agent speaking TO the customer. Never impersonate the customer.
- Each "text" must be at most 220 characters, single line, no line breaks.
- Each "label" max 40 characters — name the approach (e.g. "Direct", "Warm", "Brief").
- No double-quote characters inside label or text (use apostrophes).
- Be natural and conversational, not corporate or template-like.
- Return ONLY valid JSON matching: {"suggestions":[{"label":"...","text":"..."},...]}.
- Variation seed: ${marker}`;

  let partText: string;

  // Attempt 1: structured output with responseSchema
  try {
    partText = await fetchSuggestionsFromGemini(url, prompt, true);
  } catch (e1) {
    const msg = e1 instanceof Error ? e1.message : String(e1);
    // Auth errors are fatal — don't retry
    if (/401|403|API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
      console.error("[gemini-lead] Auth error:", msg);
      return { suggestions: [], source: "fallback" };
    }
    // Attempt 2: plain generation, ask for JSON in prompt text
    console.warn("[gemini-lead] Schema attempt failed, retrying without schema:", msg);
    try {
      partText = await fetchSuggestionsFromGemini(url, prompt, false);
    } catch (e2) {
      console.error("[gemini-lead] Both attempts failed:", e2 instanceof Error ? e2.message : e2);
      return { suggestions: [], source: "fallback" };
    }
  }

  try {
    const list = parseSuggestionsList(partText);
    if (list.length === 0) {
      console.warn("[gemini-lead] Gemini returned 0 usable suggestions. Raw:", partText.slice(0, 300));
    }
    return { suggestions: list, source: list.length > 0 ? "gemini" : "fallback" };
  } catch (parseErr) {
    console.error("[gemini-lead] JSON parse failed. Raw text:", partText.slice(0, 400), parseErr);
    return { suggestions: [], source: "fallback" };
  }
}
