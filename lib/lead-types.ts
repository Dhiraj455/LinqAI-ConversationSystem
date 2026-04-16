/**
 * Shared types for lead qualification (`lead-engine.ts`, `gemini-lead.ts`, dashboard).
 *
 * Stages mirror the SMS funnel: intro → two discovery questions → done (qualified bucket).
 */
export type LeadStage = "intro" | "question1" | "question2" | "done";

export type LeadCategory = "high" | "medium" | "low";

/** Agent → customer SMS options (human picks one to send). */
export interface LeadReplySuggestion {
  label: string;
  text: string;
}

export interface LeadAnswers {
  lookingFor?: string;
  budget?: string;
  timeline?: string;
}

export interface LeadState {
  stage: LeadStage;
  answers: LeadAnswers;
  category?: LeadCategory;
  escalate?: boolean;
  /** Short model notes for dashboard */
  intentSummary?: string;
  urgency?: "high" | "medium" | "low";
  updatedAt: string;
}

export function initialLeadState(): LeadState {
  return {
    stage: "intro",
    answers: {},
    updatedAt: new Date().toISOString(),
  };
}
