/**
 * Strip formatting and ensure a single leading + for Linq (E.164).
 * Accepts values like "+1 (310) 279-6264" or "13102796264".
 */
export function normalizeE164(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+${digits}`;
}
