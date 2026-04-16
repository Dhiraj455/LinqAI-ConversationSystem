import { normalizeE164 } from "@/lib/phone";

/** Linq dashboard “Send from” (your locked virtual line). */
export function resolveLinqSender(): string | null {
  const raw =
    process.env.LINQ_FROM_NUMBER?.trim() ||
    process.env.LINQ_VIRTUAL_NUMBER?.trim();
  return normalizeE164(raw);
}

/** Customer / device you are messaging (.env.local). */
export function resolveLinqReceiver(): string | null {
  const raw =
    process.env.LINQ_TO_NUMBER?.trim() ||
    process.env.LINQ_RECEIVER_NUMBER?.trim() ||
    process.env.LINQ_CUSTOMER_NUMBER?.trim();
  return normalizeE164(raw);
}
