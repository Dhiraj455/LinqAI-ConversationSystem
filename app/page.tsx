/**
 * Support inbox (client component).
 *
 * **Data the UI keeps**
 * - `messages` — local timeline (optimistic outbound; inbound from simulate, test box, or future hooks).
 * - `chatId` — Linq thread id once the agent sends at least once (passed to `/api/send`).
 * - `leadConversationKey` — stable `localStorage` session id (`sess_…`) for `lead-store` on the server.
 *   Not swapped for `chatId` on purpose so qualification does not reset when a chat is created.
 *
 * **Main flows**
 * - Agent send → `POST /api/send` (token server-side only).
 * - Each inbound customer line → `POST /api/lead/inbound` → dashboard state + three SMS drafts.
 * - “Load thread from Linq” → `POST /api/conversation/analyze` (merge API history + lead synthesis).
 * - Optional transcript chips → `POST /api/suggest` or bundled in analyze.
 * - Simulate / “Test as customer” — inbound without SMS; still runs the lead pipeline for demos.
 */
"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { LeadReplySuggestion, LeadState } from "@/lib/lead-types";
import { initialLeadState } from "@/lib/lead-types";

type MessageStatus = "sending" | "sent" | "failed";
type MessageDirection = "outbound" | "inbound";

interface Message {
  id: string;
  text: string;
  direction: MessageDirection;
  status: MessageStatus;
  timestamp: Date;
  traceId?: string;
  service?: string;
  kind?: "human";
}

interface SuggestedReply {
  label: string;
  text: string;
}

const INBOUND_SCENARIOS = [
  { label: "Lead: intro (interested)", intent: "lead_intro" },
  { label: "Lead: warm (use case)", intent: "lead_warm" },
  { label: "Lead: hot (budget + timeline)", intent: "lead_hot" },
  { label: "Lead: cold (browsing)", intent: "lead_cold" },
  { label: "Pricing question", intent: "pricing" },
  { label: "Schedule demo", intent: "scheduling" },
];

function stageLabel(stage: LeadState["stage"]): string {
  switch (stage) {
    case "intro":
      return "Intro";
    case "question1":
      return "Question 1 — what they need";
    case "question2":
      return "Question 2 — budget & start";
    case "done":
      return "Done — qualified";
    default:
      return stage;
  }
}

/** Must match `app/api/conversation/purge/route.ts`. */
const PURGE_CONFIRM_PHRASE = "DELETE_ALL_PARTNER_MESSAGES";

function categoryStyle(cat: LeadState["category"]): string {
  if (cat === "high") return "text-emerald-400 border-emerald-800 bg-emerald-900/30";
  if (cat === "medium") return "text-amber-400 border-amber-800 bg-amber-900/30";
  if (cat === "low") return "text-zinc-400 border-zinc-600 bg-zinc-800/50";
  return "text-zinc-500 border-zinc-700 bg-zinc-800/30";
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  /** Local-only “customer” lines for solo demos (does not send SMS). */
  const [testCustomerInput, setTestCustomerInput] = useState("");
  const [chatId, setChatId] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<SuggestedReply[]>([]);
  const [detectedIntent, setDetectedIntent] = useState<string>("");
  const [suggestionSource, setSuggestionSource] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showSimMenu, setShowSimMenu] = useState(false);
  const [localSession, setLocalSession] = useState<string | null>(null);
  const [leadSnapshot, setLeadSnapshot] = useState<LeadState | null>(null);
  const [isLeadProcessing, setIsLeadProcessing] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isSyncingLinq, setIsSyncingLinq] = useState(false);
  const [isPurgingLinq, setIsPurgingLinq] = useState(false);
  const [leadReplySuggestions, setLeadReplySuggestions] = useState<
    LeadReplySuggestion[]
  >([]);
  const [leadReplySuggestionSource, setLeadReplySuggestionSource] =
    useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const customerNumber = process.env.NEXT_PUBLIC_CUSTOMER_NUMBER ?? "+1 (555) 000-0000";

  // Stable id for lead state only — must NOT switch to Linq chatId after send, or qualification resets to intro.
  useLayoutEffect(() => {
    let k = localStorage.getItem("linq_lead_session");
    if (!k) {
      k = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("linq_lead_session", k);
    }
    setLocalSession(k);
  }, []);

  const leadConversationKey = localSession ?? "boot";

  useEffect(() => {
    if (leadConversationKey === "boot") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/lead/state?conversationKey=${encodeURIComponent(leadConversationKey)}`
        );
        const data = await res.json();
        if (!cancelled && data.state) setLeadSnapshot(data.state as LeadState);
      } catch {
        if (!cancelled) setLeadSnapshot(initialLeadState());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leadConversationKey]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const buildTranscript = useCallback((msgs: Message[]) => {
    return msgs
      .slice(-16)
      .map((m) =>
        m.direction === "inbound"
          ? `Customer: ${m.text}`
          : `Agent: ${m.text}`
      )
      .join("\n");
  }, []);

  const loadThreadFromLinq = useCallback(async () => {
    setIsSyncingLinq(true);
    setLeadReplySuggestions([]);
    setLeadReplySuggestionSource("");
    try {
      const res = await fetch("/api/conversation/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationKey:
            leadConversationKey !== "boot" ? leadConversationKey : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("/api/conversation/analyze failed:", res.status, data?.error ?? data);
        return;
      }

      const loaded: Message[] = (data.messages ?? []).map(
        (m: { id: string; createdAt: string; direction: MessageDirection; text: string }) => ({
          id: m.id,
          text: m.text,
          direction: m.direction,
          status: "sent" as const,
          timestamp: new Date(m.createdAt),
          kind: "human" as const,
        })
      );

      setChatId(data.chatId ?? undefined);
      setMessages(loaded);
      if (data.leadState) {
        setLeadSnapshot(data.leadState as LeadState);
      }

      const tr = typeof data.transcript === "string" ? data.transcript.trim() : "";
      if (!tr) {
        setSuggestions([]);
        setDetectedIntent("");
        setSuggestionSource("");
        return;
      }
      if (data.geminiError) {
        console.warn("Linq thread loaded; Gemini suggestions skipped:", data.geminiError);
      }
      setSuggestions(data.suggestions ?? []);
      setDetectedIntent(data.intent ?? "");
      setSuggestionSource(data.source ?? "");
    } catch (e) {
      console.error(e);
    } finally {
      setIsSyncingLinq(false);
    }
  }, [leadConversationKey]);

  const purgeLinqThread = useCallback(async () => {
    const w = window.confirm(
      "Delete all messages for this Linq number ↔ customer pair in Linq’s partner API?\n\n" +
        "This does NOT remove messages from anyone’s phone or iMessage — only Linq’s API/system copy (per Linq documentation).\n\n" +
        "Continue?"
    );
    if (!w) return;
    const typed = window.prompt(
      `Type exactly:\n${PURGE_CONFIRM_PHRASE}`
    );
    if (typed !== PURGE_CONFIRM_PHRASE) {
      if (typed !== null) {
        window.alert("Confirmation did not match. Nothing was deleted.");
      }
      return;
    }
    setIsPurgingLinq(true);
    try {
      const res = await fetch("/api/conversation/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: PURGE_CONFIRM_PHRASE,
          chatId: chatId ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        window.alert((data?.error as string) ?? "Purge failed — see console.");
        console.error("/api/conversation/purge:", data);
        return;
      }
      setMessages([]);
      setChatId(undefined);
      setSuggestions([]);
      setDetectedIntent("");
      setSuggestionSource("");
      setLeadReplySuggestions([]);
      setLeadReplySuggestionSource("");
      if (leadConversationKey !== "boot") {
        const rr = await fetch("/api/lead/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationKey: leadConversationKey }),
        });
        const rd = await rr.json();
        if (rr.ok && rd.state) setLeadSnapshot(rd.state as LeadState);
      } else {
        setLeadSnapshot(initialLeadState());
      }
      const errN = (data.errors as unknown[] | undefined)?.length ?? 0;
      window.alert(
        `Removed ${data.deleted ?? 0} / ${data.attempted ?? 0} message record(s) from Linq.` +
          (errN ? `\n${errN} delete(s) failed — check console.` : "")
      );
      if (errN) console.warn("Purge partial errors:", data.errors);
    } catch (e) {
      console.error(e);
      window.alert("Purge request failed.");
    } finally {
      setIsPurgingLinq(false);
    }
  }, [chatId, leadConversationKey]);

  const fetchSuggestions = useCallback(async () => {
    const transcript = buildTranscript(messages).trim();
    if (!transcript) {
      setSuggestions([]);
      setDetectedIntent("");
      setSuggestionSource("");
      return;
    }
    setIsLoadingSuggestions(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("/api/suggest failed:", res.status, data?.error ?? data);
        setSuggestions([]);
        setDetectedIntent("");
        setSuggestionSource("");
        return;
      }
      setSuggestions(data.suggestions ?? []);
      setDetectedIntent(data.intent ?? "");
      setSuggestionSource(data.source ?? "");
    } catch (err) {
      console.error(err);
      setSuggestions([]);
      setDetectedIntent("");
      setSuggestionSource("");
    } finally {
      setIsLoadingSuggestions(false);
    }
  }, [buildTranscript, messages]);

  const runLeadTurn = useCallback(
    async (
      customerText: string,
      transcript: string
    ): Promise<{ replySuggestions: LeadReplySuggestion[]; state: LeadState } | null> => {
      try {
        const res = await fetch("/api/lead/inbound", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: customerText,
            transcript: transcript.trim() || undefined,
            conversationKey: leadConversationKey,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          console.error("/api/lead/inbound failed:", res.status, data?.error ?? data);
          return null;
        }
        setLeadSnapshot(data.state as LeadState);
        const replySuggestions = (data.replySuggestions ?? []) as LeadReplySuggestion[];
        const src = data.usedGeminiReplySuggestions ? "gemini" : "fallback";
        setLeadReplySuggestions(replySuggestions);
        setLeadReplySuggestionSource(src);
        return {
          replySuggestions,
          state: data.state as LeadState,
        };
      } catch (e) {
        console.error(e);
        return null;
      }
    },
    [leadConversationKey]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending) return;

      const msgId = `msg_${Date.now()}`;
      const optimisticMsg: Message = {
        id: msgId,
        text: text.trim(),
        direction: "outbound",
        status: "sending",
        timestamp: new Date(),
        kind: "human",
      };

      setMessages((prev) => [...prev, optimisticMsg]);
      setInput("");
      setSuggestions([]);
      setLeadReplySuggestions([]);
      setLeadReplySuggestionSource("");
      setIsSending(true);

      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.trim(), chatId }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          if (!chatId) setChatId(data.chatId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? {
                    ...m,
                    status: "sent" as const,
                    traceId: data.traceId,
                    service: data.service,
                  }
                : m
            )
          );
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, status: "failed" } : m
            )
          );
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, status: "failed" } : m
          )
        );
      } finally {
        setIsSending(false);
      }
    },
    [chatId, isSending]
  );

  const simulateInbound = useCallback(
    async (intent?: string) => {
      setIsSimulating(true);
      setShowSimMenu(false);
      try {
        const res = await fetch("/api/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const text = data.message.text as string;
          const inbound: Message = {
            id: data.message.id,
            text,
            direction: "inbound",
            status: "sent",
            timestamp: new Date(data.message.timestamp),
          };
          const nextMsgs = [...messages, inbound];
          setMessages(nextMsgs);
          setIsLeadProcessing(true);
          try {
            const tr = buildTranscript(nextMsgs);
            const ok = await runLeadTurn(text, tr);
            if (!ok) {
              setLeadReplySuggestions([]);
              setLeadReplySuggestionSource("");
            }
          } finally {
            setIsLeadProcessing(false);
          }
        }
      } finally {
        setIsSimulating(false);
      }
    },
    [messages, runLeadTurn, buildTranscript]
  );

  const addInboundFromTestBox = useCallback(async () => {
    const text = testCustomerInput.trim();
    if (!text || isLeadProcessing) return;

    let capturedNext: Message[] = [];
    setMessages((prev) => {
      const inbound: Message = {
        id: `local_in_${Date.now()}`,
        text,
        direction: "inbound",
        status: "sent",
        timestamp: new Date(),
      };
      capturedNext = [...prev, inbound];
      return capturedNext;
    });
    setTestCustomerInput("");
    setIsLeadProcessing(true);
    try {
      const tr = buildTranscript(capturedNext);
      const ok = await runLeadTurn(text, tr);
      if (!ok) {
        setLeadReplySuggestions([]);
        setLeadReplySuggestionSource("");
      }
    } finally {
      setIsLeadProcessing(false);
    }
  }, [
    testCustomerInput,
    isLeadProcessing,
    buildTranscript,
    runLeadTurn,
  ]);

  const resetQualification = useCallback(async () => {
    setIsResetting(true);
    try {
      const res = await fetch("/api/lead/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationKey: leadConversationKey }),
      });
      const data = await res.json();
      if (res.ok && data.state) {
        setLeadSnapshot(data.state as LeadState);
        setMessages([]);
        setLeadReplySuggestions([]);
        setLeadReplySuggestionSource("");
      }
    } finally {
      setIsResetting(false);
    }
  }, [leadConversationKey]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const formatTime = (date: Date) =>
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const statusIcon = (status: MessageStatus) => {
    if (status === "sending") return <span className="text-zinc-400">○</span>;
    if (status === "sent") return <span className="text-blue-400">✓</span>;
    if (status === "failed") return <span className="text-red-400">✗</span>;
  };

  const displayLead = leadSnapshot ?? initialLeadState();
  const hasExtractedDetails =
    !!displayLead.intentSummary ||
    !!displayLead.answers.lookingFor ||
    !!displayLead.answers.budget ||
    !!displayLead.answers.timeline;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-50 font-sans">
      {/* Lead qualification dashboard */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">
              AI lead qualification
            </p>
            <p className="text-xs text-zinc-400 mt-0.5">
              After each customer message, Gemini proposes three agent-to-customer replies; you pick one to send. Extraction covers intent, urgency, budget, and category.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void resetQualification()}
            disabled={isResetting}
            className="text-xs rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          >
            {isResetting ? "Resetting…" : "Reset thread & state"}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2">
            <p className="text-zinc-500 mb-0.5">Stage</p>
            <p className="text-zinc-200 font-medium">{stageLabel(displayLead.stage)}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2">
            <p className="text-zinc-500 mb-0.5">Urgency</p>
            <p className="text-zinc-200 font-medium capitalize">
              {displayLead.urgency ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2">
            <p className="text-zinc-500 mb-0.5">Category</p>
            <p
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium capitalize ${categoryStyle(displayLead.category)}`}
            >
              {displayLead.category ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2">
            <p className="text-zinc-500 mb-0.5">Escalate</p>
            <p className="text-zinc-200 font-medium">
              {displayLead.escalate === true
                ? "Yes — human follow-up"
                : displayLead.escalate === false
                  ? "No"
                  : "—"}
            </p>
          </div>
        </div>
        {hasExtractedDetails && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-400 space-y-1 font-mono">
            {displayLead.intentSummary && (
              <p>
                <span className="text-zinc-500">Intent:</span> {displayLead.intentSummary}
              </p>
            )}
            {displayLead.answers.lookingFor && (
              <p>
                <span className="text-zinc-500">Looking for:</span>{" "}
                {displayLead.answers.lookingFor}
              </p>
            )}
            {displayLead.answers.budget && (
              <p>
                <span className="text-zinc-500">Budget:</span> {displayLead.answers.budget}
              </p>
            )}
            {displayLead.answers.timeline && (
              <p>
                <span className="text-zinc-500">Timeline:</span>{" "}
                {displayLead.answers.timeline}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <div className="flex items-center justify-center w-9 h-9 rounded-full bg-indigo-600 text-sm font-semibold shrink-0">
          C
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">Customer</p>
          <p className="text-xs text-zinc-400 truncate">{customerNumber}</p>
        </div>
        <div className="flex items-center gap-2">
          {chatId && (
            <span className="text-xs text-zinc-500 font-mono hidden sm:block" title="Linq Chat ID">
              #{chatId.slice(0, 8)}
            </span>
          )}
          {isLeadProcessing && (
            <span className="text-xs text-amber-400/90">Qualifying…</span>
          )}
          <span className="inline-flex items-center gap-1 text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-600/30 flex items-center justify-center text-2xl">
              💬
            </div>
            <div>
              <p className="text-zinc-300 font-medium">No messages yet</p>
              <p className="text-zinc-500 text-sm mt-1">
                Text the customer from your phone (Linq), use Load thread from Linq + AI to mirror the thread here, then pick suggested replies. Simulate is optional for demos without a phone.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
          >
            <div className={`max-w-[75%] ${msg.direction === "outbound" ? "items-end" : "items-start"} flex flex-col gap-1`}>
              {msg.direction === "inbound" && (
                <span className="text-xs text-zinc-500 px-1">Customer</span>
              )}
              <div
                className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.direction === "outbound"
                    ? msg.status === "failed"
                      ? "bg-red-900/60 border border-red-700 text-red-200"
                      : "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-100 border border-zinc-700"
                }`}
              >
                {msg.text}
              </div>
              <div className={`flex items-center gap-1.5 px-1 text-[11px] text-zinc-500 ${msg.direction === "outbound" ? "flex-row-reverse" : ""}`}>
                <span>{formatTime(msg.timestamp)}</span>
                {msg.direction === "outbound" && statusIcon(msg.status)}
                {msg.status === "failed" && (
                  <button
                    onClick={() => sendMessage(msg.text)}
                    className="text-red-400 hover:text-red-300 underline"
                  >
                    Retry
                  </button>
                )}
                {msg.traceId && (
                  <span
                    className="font-mono text-zinc-600 hidden sm:block"
                    title={`Trace ID: ${msg.traceId}`}
                  >
                    trace:{msg.traceId.slice(0, 6)}
                  </span>
                )}
                {msg.service && (
                  <span className="text-zinc-600">{msg.service}</span>
                )}
              </div>
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Lead flow: agent → customer only (pick one to send) */}
      {!isLeadProcessing && leadReplySuggestions.length === 0 && messages.some(m => m.direction === "inbound") && (
        <div className="px-4 pb-2 pt-2 shrink-0 border-t border-zinc-800/80 bg-zinc-900/50">
          <p className="text-[11px] text-zinc-500 italic">
            Suggestions unavailable — check server logs for Gemini errors, or try sending another customer message.
          </p>
        </div>
      )}
      {leadReplySuggestions.length > 0 && (
        <div className="px-4 pb-2 shrink-0 border-t border-zinc-800/80 bg-zinc-900/50 pt-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-[11px] text-violet-300 uppercase tracking-wider font-medium">
              Reply to customer (lead flow)
            </span>
            {leadReplySuggestionSource && (
              <span className="text-[11px] text-zinc-500 border border-zinc-700 px-2 py-0.5 rounded-full">
                {leadReplySuggestionSource}
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 mb-2">
            These options are only for messages you send to the customer — not for what they should type.
          </p>
          <div className="flex flex-wrap gap-2">
            {leadReplySuggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  void sendMessage(s.text);
                }}
                disabled={isSending}
                className="text-sm bg-violet-900/50 hover:bg-violet-800/60 border border-violet-700/60 text-violet-100 px-3 py-1.5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left max-w-full"
                title={s.text}
              >
                <span className="font-medium">{s.label}</span>
                <span className="block text-[11px] text-violet-200/90 font-normal truncate max-w-[280px]">
                  {s.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Optional: other agent reply ideas from full transcript (not tied to qualification beats) */}
      <div className="px-4 pb-2 shrink-0 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void loadThreadFromLinq()}
          disabled={isSyncingLinq || isPurgingLinq}
          title="Uses Partner API: list chats (from + to), then GET messages — same thread as the Linq sandbox Phone UI"
          className="text-[11px] rounded-lg border border-indigo-700 bg-indigo-950/50 px-2.5 py-1 text-indigo-200 hover:bg-indigo-900/40 disabled:opacity-40"
        >
          {isSyncingLinq ? "Syncing Linq…" : "Load thread from Linq + AI"}
        </button>
        <button
          type="button"
          onClick={() => void purgeLinqThread()}
          disabled={isSyncingLinq || isPurgingLinq}
          title="DELETE /v3/messages/{id} for each message — Linq API copy only, not customer phones"
          className="text-[11px] rounded-lg border border-red-900 bg-red-950/40 px-2.5 py-1 text-red-200 hover:bg-red-900/30 disabled:opacity-40"
        >
          {isPurgingLinq ? "Purging…" : "Purge Linq thread (API only)"}
        </button>
        <button
          type="button"
          onClick={() => void fetchSuggestions()}
          disabled={isLoadingSuggestions || isPurgingLinq || messages.length === 0}
          className="text-[11px] rounded-lg border border-zinc-600 bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          {isLoadingSuggestions ? "Loading…" : "Other reply ideas from transcript"}
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="px-4 pb-2 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">
              Transcript-based suggestions
            </span>
            {suggestionSource && (
              <span className="text-[11px] text-zinc-500 border border-zinc-700 px-2 py-0.5 rounded-full">
                {suggestionSource}
              </span>
            )}
            {detectedIntent && (
              <span className="text-[11px] text-indigo-400 bg-indigo-900/30 border border-indigo-800 px-2 py-0.5 rounded-full">
                {detectedIntent}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => sendMessage(s.text)}
                disabled={isSending}
                className="text-sm bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 text-zinc-200 px-3 py-1.5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="px-4 pb-4 pt-2 border-t border-zinc-800 bg-zinc-900 shrink-0">
        <div className="mb-3 pb-3 border-b border-zinc-800/80">
          <p className="text-[11px] text-zinc-500 mb-1.5">
            Test as customer — does not send SMS; advances lead flow + suggestions
          </p>
          <div className="flex items-end gap-2">
            <input
              type="text"
              value={testCustomerInput}
              onChange={(e) => setTestCustomerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addInboundFromTestBox();
                }
              }}
              placeholder="Type a customer line…"
              disabled={isLeadProcessing || leadConversationKey === "boot"}
              className="flex-1 min-w-0 bg-zinc-800/80 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void addInboundFromTestBox()}
              disabled={
                !testCustomerInput.trim() ||
                isLeadProcessing ||
                leadConversationKey === "boot"
              }
              className="shrink-0 rounded-xl border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add inbound
            </button>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="relative shrink-0">
            <button
              onClick={() => setShowSimMenu((v) => !v)}
              disabled={isSimulating || isLeadProcessing}
              title="Simulate incoming lead message"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
            >
              {isSimulating ? (
                <span className="animate-spin text-sm">⟳</span>
              ) : (
                <span className="text-sm">↙</span>
              )}
            </button>

            {showSimMenu && (
              <div className="absolute bottom-12 left-0 w-56 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl overflow-hidden z-10">
                <div className="px-3 py-2 border-b border-zinc-700">
                  <p className="text-xs text-zinc-400 font-medium">Simulate inbound</p>
                </div>
                {INBOUND_SCENARIOS.map(({ label, intent }) => (
                  <button
                    key={label}
                    onClick={() => void simulateInbound(intent)}
                    className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Manual agent message via Linq (Enter to send)…"
            rows={1}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-indigo-500 transition-colors leading-relaxed"
            style={{ minHeight: "42px", maxHeight: "120px" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />

          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isSending}
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition-colors"
          >
            {isSending ? (
              <span className="text-xs animate-spin">⟳</span>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-4 h-4 rotate-90"
              >
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {showSimMenu && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setShowSimMenu(false)}
        />
      )}
    </div>
  );
}
