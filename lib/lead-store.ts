/**
 * In-memory qualification state per conversation (key = chatId or browser session id).
 * Resets on server restart; use a DB in production.
 */
import { initialLeadState, type LeadState } from "@/lib/lead-types";

const store = new Map<string, LeadState>();

export function getLeadState(key: string): LeadState {
  const existing = store.get(key);
  if (existing) return existing;
  const fresh = initialLeadState();
  store.set(key, fresh);
  return fresh;
}

export function setLeadState(key: string, state: LeadState): void {
  store.set(key, { ...state, updatedAt: new Date().toISOString() });
}

export function resetLeadState(key: string): LeadState {
  const fresh = initialLeadState();
  store.set(key, fresh);
  return fresh;
}
