import {
  extractAfterQ1,
  extractFinal,
  extractIntro,
  generateLeadAgentReplySuggestions,
  type ExtractedLeadContext,
} from "@/lib/gemini-lead";
import { getLeadState, setLeadState } from "@/lib/lead-store";
import { initialLeadState } from "@/lib/lead-types";
import type {
  LeadReplySuggestion,
  LeadStage,
  LeadState,
} from "@/lib/lead-types";

/**
 * Lead qualification: each inbound customer message advances a small state machine
 * (intro → question1 → question2 → done). Gemini extracts fields AND generates
 * all three reply suggestions — nothing is hardcoded.
 */
export interface LeadProcessResult {
  replySuggestions: LeadReplySuggestion[];
  state: LeadState;
  usedGemini: boolean;
  usedGeminiReplySuggestions: boolean;
  error?: string;
}

function fallbackIntroExtraction(text: string) {
  const t = text.toLowerCase();
  let urgency: "high" | "medium" | "low" = "medium";
  if (/\b(urgent|asap|today|this week|immediately)\b/.test(t)) urgency = "high";
  if (/\b(just looking|maybe|someday|next year)\b/.test(t)) urgency = "low";
  return { intentSummary: text.slice(0, 80) || text.trim(), urgency };
}

function fallbackFinal(
  answers: LeadState["answers"],
  urgency: "high" | "medium" | "low" | undefined
): { category: "high" | "medium" | "low"; escalate: boolean } {
  const u = urgency ?? "medium";
  if (u === "high") return { category: "high", escalate: true };
  if (u === "low") return { category: "low", escalate: false };
  return { category: "medium", escalate: false };
}

function buildTranscriptForFinal(customerMessage: string, state: LeadState): string {
  const parts: string[] = [];
  if (state.answers.lookingFor) parts.push(`Customer (needs): ${state.answers.lookingFor}`);
  if (state.intentSummary) parts.push(`Summary: ${state.intentSummary}`);
  parts.push(`Customer (latest): ${customerMessage}`);
  return parts.join("\n");
}

async function suggestReplies(
  transcript: string,
  stage: LeadStage | "empty" | "done_followup" | "error_recovery",
  extractedContext?: ExtractedLeadContext
): Promise<{ suggestions: LeadReplySuggestion[]; usedGeminiReplySuggestions: boolean }> {
  const { suggestions, source } = await generateLeadAgentReplySuggestions({
    transcript,
    stage,
    extractedContext,
  });
  return { suggestions, usedGeminiReplySuggestions: source === "gemini" };
}

/** One inbound SMS: update stored state + return 3 reply suggestions for the agent. */
const MAX_REPLAY_INBOUND = 24;

/**
 * Replays the qualification pipeline over each customer line in order (fallback when
 * full-thread synthesis fails). Mutates stored state for `conversationKey`.
 */
export async function replayLeadQualificationFromThread(
  conversationKey: string,
  thread: Array<{ direction: "inbound" | "outbound"; text: string }>
): Promise<LeadProcessResult> {
  setLeadState(conversationKey, initialLeadState());
  let last: LeadProcessResult = {
    replySuggestions: [],
    state: getLeadState(conversationKey),
    usedGemini: false,
    usedGeminiReplySuggestions: false,
  };
  const lines: string[] = [];
  let inboundSeen = 0;

  for (const m of thread) {
    const label = m.direction === "inbound" ? "Customer" : "Agent";
    lines.push(`${label}: ${m.text}`);
    if (m.direction !== "inbound") continue;
    const t = m.text.trim();
    if (!t || t === "(no text)") continue;
    inboundSeen += 1;
    if (inboundSeen > MAX_REPLAY_INBOUND) break;
    last = await processLeadInbound(conversationKey, t, lines.join("\n"));
  }

  return last;
}

export async function processLeadInbound(
  conversationKey: string,
  customerText: string,
  transcriptForSuggestions?: string
): Promise<LeadProcessResult> {
  const transcript = (
    transcriptForSuggestions?.trim() || `Customer: ${customerText.trim()}`
  ).slice(0, 4000);

  const trimmed = customerText.trim();

  if (!trimmed) {
    const state = getLeadState(conversationKey);
    const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
      transcript,
      "empty"
    );
    return { replySuggestions: suggestions, state, usedGemini: false, usedGeminiReplySuggestions };
  }

  let state = getLeadState(conversationKey);
  let usedGemini = false;

  try {
    // ── intro ────────────────────────────────────────────────────────────────
    if (state.stage === "intro") {
      try {
        const ex = await extractIntro(trimmed);
        usedGemini = true;
        state = { ...state, intentSummary: ex.intentSummary, urgency: ex.urgency, stage: "question1" };
      } catch {
        const fb = fallbackIntroExtraction(trimmed);
        state = { ...state, intentSummary: fb.intentSummary, urgency: fb.urgency, stage: "question1" };
      }
      setLeadState(conversationKey, state);
      const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
        transcript,
        "question1",
        { intentSummary: state.intentSummary, urgency: state.urgency } as ExtractedLeadContext
      );
      return { replySuggestions: suggestions, state, usedGemini, usedGeminiReplySuggestions };
    }

    // ── question1 ────────────────────────────────────────────────────────────
    if (state.stage === "question1") {
      try {
        const ex = await extractAfterQ1(trimmed, { ...state.answers, intentSummary: state.intentSummary });
        usedGemini = true;
        state = {
          ...state,
          answers: { ...state.answers, lookingFor: ex.lookingFor },
          intentSummary: ex.intentSummary,
          urgency: ex.urgency,
          stage: "question2",
        };
      } catch {
        state = {
          ...state,
          answers: { ...state.answers, lookingFor: trimmed.slice(0, 500) },
          stage: "question2",
        };
      }
      setLeadState(conversationKey, state);
      const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
        transcript,
        "question2",
        {
          intentSummary: state.intentSummary,
          lookingFor: state.answers.lookingFor,
          urgency: state.urgency,
        } as ExtractedLeadContext
      );
      return { replySuggestions: suggestions, state, usedGemini, usedGeminiReplySuggestions };
    }

    // ── question2 ────────────────────────────────────────────────────────────
    if (state.stage === "question2") {
      let category: "high" | "medium" | "low";
      let escalate: boolean;

      try {
        const transcriptFinal = buildTranscriptForFinal(trimmed, state);
        const ex = await extractFinal(trimmed, transcriptFinal, state.stage);
        usedGemini = true;
        category = ex.category;
        escalate = ex.escalate;
        state = {
          ...state,
          answers: { ...state.answers, budget: ex.budget, timeline: ex.timeline },
          intentSummary: ex.intentSummary,
          urgency: ex.urgency,
          category,
          escalate,
          stage: "done",
        };
      } catch {
        const fb = fallbackFinal(state.answers, state.urgency);
        category = fb.category;
        escalate = fb.escalate;
        state = {
          ...state,
          answers: { ...state.answers, budget: state.answers.budget || trimmed.slice(0, 200) },
          category,
          escalate,
          stage: "done",
        };
      }
      setLeadState(conversationKey, state);
      const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
        transcript,
        "done",
        {
          intentSummary: state.intentSummary,
          lookingFor: state.answers.lookingFor,
          budget: state.answers.budget,
          timeline: state.answers.timeline,
          category: state.category,
          escalate: state.escalate,
        }
      );
      return { replySuggestions: suggestions, state, usedGemini, usedGeminiReplySuggestions };
    }

    // ── done (subsequent messages after qualification) ───────────────────────
    state = { ...state, stage: "done" };
    setLeadState(conversationKey, state);
    const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
      transcript,
      "done_followup",
      {
        intentSummary: state.intentSummary,
        category: state.category,
        escalate: state.escalate,
      }
    );
    return { replySuggestions: suggestions, state, usedGemini: false, usedGeminiReplySuggestions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { suggestions, usedGeminiReplySuggestions } = await suggestReplies(
      transcript,
      "error_recovery"
    );
    return {
      replySuggestions: suggestions,
      state: getLeadState(conversationKey),
      usedGemini,
      usedGeminiReplySuggestions,
      error: message,
    };
  }
}
