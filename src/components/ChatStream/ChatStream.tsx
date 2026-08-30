import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  ArrowUp,
  Trash2,
  Copy,
  Check,
  Sparkles,
  Bot,
  User,
  Terminal,
  Volume2,
  CornerDownLeft,
  History,
  Maximize2,
  AlertTriangle,
} from 'lucide-react';
import { ToolCallLogItem, TranscriptItem, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';
import { writeClipboard } from '../../utils/clipboard';
import { FloatingQuickPrompts } from './FloatingQuickPrompts';

interface ChatStreamProps {
  transcripts: TranscriptItem[];
  toolLogs?: ToolCallLogItem[];
  onSendMessage: (text: string) => void;
  onClearHistory: () => void;
  onOpenFullHistory: () => void;
  /** Opens the Full History drawer directly on the TOOLS tab. */
  onOpenTools?: () => void;
  paletteId?: ColorPaletteId;
  customColor?: string;
  isSpeaking?: boolean;
  isConnected?: boolean;
  state?: string;
  /** v1.8.4: surfaced engine failures (e.g. "Ollama is not running") — shown right above the input where the user is looking when nothing answers. */
  errorMessage?: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

interface FallingCardState {
  text: string;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  targetX: number;
  targetY: number;
  targetWidth: number;
}

export const ChatStream: React.FC<ChatStreamProps> = React.memo(({
  transcripts,
  toolLogs = [],
  onSendMessage,
  onClearHistory,
  onOpenFullHistory,
  onOpenTools,
  paletteId,
  customColor,
  isSpeaking,
  isConnected,
  state,
  errorMessage,
  isOpen,
}) => {
  const [inputText, setInputText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const palette = getPaletteConfig(paletteId, customColor);

  // Track active timers / animation frames so they can be cancelled on
  // unmount. Previously the auto-typing interval, the copy-reset timeout,
  // and the drop animation rAF all kept firing on an unmounted component,
  // causing setState-after-unmount warnings and (in some browsers) console
  // spam during rapid open/close of the chat stream.
  const typeIntervalRef = useRef<number | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropRafRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (typeIntervalRef.current !== null) window.clearInterval(typeIntervalRef.current);
      if (copyResetTimerRef.current !== null) clearTimeout(copyResetTimerRef.current);
      if (sendPulseTimerRef.current !== null) clearTimeout(sendPulseTimerRef.current);
      if (sendDispatchTimerRef.current !== null) clearTimeout(sendDispatchTimerRef.current);
      if (dropRafRef.current !== null) cancelAnimationFrame(dropRafRef.current);
    };
  }, []);

  // Copy a transcript to the clipboard. The old implementation fired
  // navigator.clipboard.writeText() and never checked the result, so inside
  // Electron the button showed "copied" while the clipboard stayed empty.
  // Now the write goes through the layered fallbacks in utils/clipboard and
  // the button only confirms on a real success.
  const handleCopy = async (id: string, text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await writeClipboard(text);
    if (!isMountedRef.current) return;
    if (copyResetTimerRef.current !== null) clearTimeout(copyResetTimerRef.current);
    if (ok) {
      setCopyFailedId(null);
      setCopiedId(id);
    } else {
      console.warn('[ChatStream] clipboard write failed for message', id);
      setCopiedId(null);
      setCopyFailedId(id);
    }
    copyResetTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setCopiedId(null);
        setCopyFailedId(null);
      }
      copyResetTimerRef.current = null;
    }, 1800);
  };

  // ─── Fall-Down & Fast Type States ────────────────────────────────────
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [isPromptAnimating, setIsPromptAnimating] = useState(false);
  const [hasPromptBeenUsed, setHasPromptBeenUsed] = useState(false);
  const [fallingCard, setFallingCard] = useState<FallingCardState | null>(null);
  const [fallProgress, setFallProgress] = useState(0);
  const [isAutoTyping, setIsAutoTyping] = useState(false);
  const [isSendingPulse, setIsSendingPulse] = useState(false);

  // Smart auto-scroll: jump to the newest message ONLY when the user is
  // already reading near the bottom. If they scrolled up to re-read the
  // conversation, their position is preserved instead of being yanked
  // back down on every new transcript/tool update.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 140) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcripts]);

  // Handle standard manual send
  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || isAutoTyping) return;
    setHasPromptBeenUsed(true);
    onSendMessage(trimmed);
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Reset prompt visibility when history is explicitly cleared and in standby
  const handleClear = () => {
    setHasPromptBeenUsed(false);
    onClearHistory();
  };

  // ─── Triggered when user selects a prompt: fall-down animation ───────
  const handleSelectQuickPrompt = useCallback(
    (promptText: string, sourceRect: DOMRect, itemId: string) => {
      if (isPromptAnimating || isAutoTyping || !inputContainerRef.current) return;

      // Lock prompt disappearance permanently so it never flashes back
      setHasPromptBeenUsed(true);
      setSelectedPromptId(itemId);
      setIsPromptAnimating(true);

      const targetRect = inputContainerRef.current.getBoundingClientRect();

      setFallingCard({
        text: promptText,
        startX: sourceRect.left,
        startY: sourceRect.top,
        startWidth: sourceRect.width,
        startHeight: sourceRect.height,
        targetX: targetRect.left,
        targetY: targetRect.top,
        targetWidth: targetRect.width,
      });

      // ── Step 1: Smooth downward fall/drop animation (260ms) ──
      const durationMs = 260;
      const startTime = performance.now();

      const animateDrop = (now: number) => {
        const elapsed = now - startTime;
        const rawT = Math.min(1, elapsed / durationMs);
        // Natural gravity ease (starts smoothly, accelerates and soft lands)
        const easeT = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

        setFallProgress(easeT);

        if (rawT < 1) {
          dropRafRef.current = requestAnimationFrame(animateDrop);
        } else {
          dropRafRef.current = null;
          // ── Step 2: Landed on input box -> start auto-typing ──
          setFallingCard(null);
          setIsPromptAnimating(false);
          startAutoTyping(promptText);
        }
      };

      dropRafRef.current = requestAnimationFrame(animateDrop);
    },
    [isPromptAnimating, isAutoTyping]
  );

  // ─── Step 3: Fast, natural auto-typewriter (12ms/char) ───────────────
  const startAutoTyping = useCallback(
    (fullText: string) => {
      setIsAutoTyping(true);
      setInputText('');

      let charIndex = 0;
      const typeSpeed = 12; // Fast & crisp

      if (typeIntervalRef.current !== null) window.clearInterval(typeIntervalRef.current);
      typeIntervalRef.current = window.setInterval(() => {
        charIndex++;
        setInputText(fullText.slice(0, charIndex));

        if (charIndex >= fullText.length) {
          if (typeIntervalRef.current !== null) {
            window.clearInterval(typeIntervalRef.current);
            typeIntervalRef.current = null;
          }

          // Flash send button and dispatch
          sendPulseTimerRef.current = setTimeout(() => {
            if (!isMountedRef.current) return;
            setIsSendingPulse(true);
            sendDispatchTimerRef.current = setTimeout(() => {
              if (!isMountedRef.current) return;
              onSendMessage(fullText);
              setInputText('');
              setIsAutoTyping(false);
              setIsSendingPulse(false);
            }, 100);
          }, 60);
        }
      }, typeSpeed);
    },
    [onSendMessage]
  );

  // Quick prompts only display when in standby and not yet used / no messages
  const isLiveOrActive = Boolean(isConnected) || (state !== 'idle' && state !== 'disconnected' && Boolean(state));
  const showQuickPrompts = !isLiveOrActive && transcripts.length === 0 && !hasPromptBeenUsed && !isAutoTyping;

  // Tool activity summary for the compact pill (tools no longer render
  // inside the chat stream itself).
  const hasRunningTool = toolLogs.some((t) => t.status === 'executing' || t.status === 'pending');
  const latestTool = toolLogs[toolLogs.length - 1];
  const latestToolLabel = latestTool
    ? `${latestTool.name} ${latestTool.status === 'success' ? '✓' : latestTool.status === 'failed' || latestTool.status === 'rejected' ? '✕' : '…'}`
    : '';

  return (
    <aside
      aria-label="Live transparent chat HUD"
      className="pointer-events-none fixed right-4 sm:right-6 bottom-6 top-[96px] z-30 flex w-[min(92vw,380px)] flex-col justify-end select-none"
    >
      {/* ── FALLING CARD ANIMATION OVERLAY ── */}
      {fallingCard && (
        <div
          className="fixed pointer-events-none z-[9999] flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5 font-sans text-xs font-medium text-white backdrop-blur-2xl transition-none"
          style={{
            left: `${fallingCard.startX}px`,
            top: `${fallingCard.startY + (fallingCard.targetY - fallingCard.startY) * fallProgress}px`,
            width: `${fallingCard.startWidth}px`,
            height: `${fallingCard.startHeight}px`,
            background: `linear-gradient(135deg, ${palette.lamp}40 0%, rgba(255, 255, 255, 0.12) 100%)`,
            border: `1.5px solid ${palette.lamp}`,
            boxShadow: `0 8px 32px rgba(0, 0, 0, 0.6), 0 0 20px ${palette.lamp}70`,
            opacity: Math.max(0.2, 1 - fallProgress * 0.4),
            transform: `scale(${1 - fallProgress * 0.04})`,
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg"
              style={{ background: `${palette.lamp}40`, color: palette.lamp }}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="truncate font-medium text-white">{fallingCard.text}</span>
          </div>
          <Send className="h-3.5 w-3.5 shrink-0" style={{ color: palette.lamp }} />
        </div>
      )}

      {/* ── BORDERLESS UPWARD-FLOWING LIVE CHAT STREAM (CHAT ONLY) ──
          Tool executions deliberately do NOT live here — they flood the
          conversation and made the area feel like a build log. They show
          in the compact activity pill + Full History → TOOLS. */}
      {isOpen && (
        /* v1.6.8: hard height cap — the HUD stream used to grow to
           calc(100vh-170px) and on short/desktop windows its header row
           collided with the top-right toolbar (the "Fix this overlapping
           issue" report). It is now capped at 52vh and the aside itself is
           bounded below the header, so the stream can NEVER reach the
           toolbar row again. Messages scroll inside the capped area. */
        <div className="relative flex min-h-0 flex-col justify-end overflow-hidden mb-2.5 max-h-[52vh]">
          {/* Subtle Quick Header with Full History Action */}
          {transcripts.length > 0 && (
            <div className="pointer-events-auto mb-2 flex shrink-0 items-center justify-between px-2 font-mono text-[9px] text-white/40">
              <span className="flex items-center gap-1.5 font-bold tracking-widest text-white/50 uppercase">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.lamp }} />
                LIVE HUD STREAM
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenFullHistory}
                  className="group flex items-center gap-1 rounded-md px-1.5 py-0.5 text-white/50 backdrop-blur-md transition hover:bg-white/10 hover:text-white"
                  title="Open Full History & Logs Drawer"
                >
                  <History className="h-3 w-3 transition-transform group-hover:rotate-45" />
                  <span>FULL HISTORY</span>
                </button>

                <button
                  type="button"
                  onClick={handleClear}
                  className="rounded-md p-0.5 text-white/30 transition hover:bg-white/10 hover:text-red-400"
                  title="Clear HUD messages"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}

          {/* ── Scroll wrapper: pins the stream to the bottom while keeping
              the inner scroller free of flexbox overflow quirks. The old
              single-container version had justify-end + overflow on the
              same element, which (a) let flex children grow past the
              max-height without ever scrolling (missing min-height: 0)
              and (b) makes top content unreachable once it overflows.
              Wrapper pins; scroller scrolls — both behaviors work. */}
          <div className="flex min-h-0 flex-1 flex-col justify-end">
            <div
              ref={scrollRef}
              className="sera-scroll pointer-events-auto max-h-full space-y-2.5 overflow-y-auto overflow-x-hidden px-1 pb-1 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.22)_transparent]"
              style={
                transcripts.length > 0
                  ? {
                      maskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 8%, rgba(0,0,0,0.85) 20%, black 35%, black 100%)',
                      WebkitMaskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 8%, rgba(0,0,0,0.85) 20%, black 35%, black 100%)',
                    }
                  : undefined
              }
            >
              {showQuickPrompts && (
                /* ── CRISP, CLEAN QUICK PROMPT CARDS (STANDBY ONLY) ── */
                <FloatingQuickPrompts
                  onSelectPrompt={handleSelectQuickPrompt}
                  lampColor={palette.lamp}
                  isAnimating={isPromptAnimating}
                  selectedId={selectedPromptId}
                />
              )}

              {/* Upward-Floating Translucent Glass Messages — CHAT ONLY.
                  Tool executions are NOT rendered here: they flooded the
                  conversation area (12+ CONTROLCOMPUTERINPUT cards burying
                  the actual chat). Tools live in the activity pill below
                  the stream and in Full History → TOOLS. */}
            {transcripts.map((t, idx) => {
              const isUser = t.sender === 'user';
              const isLatestSera = !isUser && idx === transcripts.length - 1;

              return (
                <div
                  key={t.id || idx}
                  onClick={onOpenFullHistory}
                  className={`group relative flex flex-col cursor-pointer transition-transform duration-200 hover:scale-[1.01] ${
                    isUser ? 'items-end' : 'items-start'
                  } animate-fade-up`}
                  title="Click to inspect in Full Conversation History"
                >
                  {/* Header Badge */}
                  <div className="mb-1 flex items-center gap-1.5 px-2 font-mono text-[9px] tracking-wider text-white/40">
                    {isUser ? (
                      <>
                        <span>{formatTime(t.timestamp)}</span>
                        <span className="font-extrabold text-white/70">YOU</span>
                        <User className="h-2.5 w-2.5" />
                      </>
                    ) : (
                      <>
                        <Bot className="h-2.5 w-2.5" style={{ color: palette.lamp }} />
                        <span className="font-extrabold" style={{ color: palette.lamp }}>
                          SERA
                        </span>
                        {isLatestSera && isSpeaking && (
                          <span className="flex items-center gap-1 text-[8px] font-black uppercase text-emerald-400">
                            <Volume2 className="h-2.5 w-2.5 animate-pulse" />
                            SPEAKING
                          </span>
                        )}
                        <span>{formatTime(t.timestamp)}</span>
                      </>
                    )}
                  </div>

                  {/* Glass Message Card */}
                  <div
                    className={`relative max-w-[92%] rounded-2xl p-3 text-xs backdrop-blur-2xl transition-all duration-200 ${
                      isUser
                        ? 'border border-white/15 bg-white/[0.06] text-white font-medium shadow-[0_4px_20px_rgba(0,0,0,0.3)] hover:bg-white/[0.10]'
                        : 'border border-white/10 bg-black/35 text-white/90 shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:bg-black/45'
                    }`}
                    style={{
                      borderLeftColor: !isUser ? palette.lamp : undefined,
                      borderLeftWidth: !isUser ? '2.5px' : undefined,
                      boxShadow: isUser
                        ? '0 4px 20px rgba(0,0,0,0.3)'
                        : `0 4px 20px rgba(0,0,0,0.4), 0 0 16px ${palette.lamp}10`,
                    }}
                  >
                    <p className="leading-relaxed whitespace-pre-wrap select-text">{t.text}</p>

                    {/* Action buttons on hover */}
                    <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => handleCopy(t.id || String(idx), t.text, e)}
                        className="rounded-md bg-black/50 p-1 text-white/50 backdrop-blur-md transition hover:text-white"
                        title="Copy message"
                      >
                        {copiedId === (t.id || String(idx)) ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : copyFailedId === (t.id || String(idx)) ? (
                          <span className="text-[10px] font-semibold leading-none text-rose-400">✕</span>
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                      <span
                        className="rounded-md bg-black/50 p-1 text-white/50 backdrop-blur-md"
                        title="Open in Full History"
                      >
                        <Maximize2 className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

          </div>
          </div>
        </div>
      )}

      {/* ── COMPACT TOOL ACTIVITY PILL (tools live here, NOT in the chat) ──
          One slim line: spinner while executing, latest tool name, total
          count. Click opens the Full History drawer on the TOOLS tab with
          the complete execution log. */}
      {isOpen && toolLogs.length > 0 && (
        <button
          type="button"
          onClick={() => (onOpenTools ? onOpenTools() : onOpenFullHistory())}
          className="pointer-events-auto group mb-1.5 flex w-full items-center gap-2 rounded-xl border border-white/10 bg-black/35 px-3 py-1.5 font-mono text-[9px] text-white/60 backdrop-blur-xl transition hover:border-white/25 hover:bg-black/55 hover:text-white/90"
          title="Open tool execution logs"
        >
          <Terminal
            className={`h-3 w-3 shrink-0 text-cyan-400 ${
              hasRunningTool ? 'animate-pulse' : ''
            }`}
          />
          {hasRunningTool ? (
            <span className="font-bold tracking-widest text-cyan-300">TOOL RUNNING…</span>
          ) : (
            <span className="font-bold tracking-widest text-white/50">TOOL ACTIVITY</span>
          )}
          <span className="truncate uppercase">{latestToolLabel}</span>
          <span className="ml-auto shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-bold text-white/60 group-hover:text-white">
            {toolLogs.length}
          </span>
        </button>
      )}

      {/* v1.8.4 — engine failure strip: when a local-mode (or online)
          turn fails, the error used to go NOWHERE — the user's message
          appeared, nothing answered, and the chat gave no explanation.
          Now the exact reason + fix sits right above the input. */}
      {errorMessage && (
        <div
          role="alert"
          className="animate-fade-up pointer-events-auto mb-2 flex w-full items-start gap-2 rounded-2xl border border-red-500/30 bg-red-950/50 px-3 py-2 backdrop-blur-3xl"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-red-400" />
          <p className="font-mono text-[9px] leading-relaxed text-red-200/90">{errorMessage}</p>
        </div>
      )}

      {/* ── BORDERLESS FLOATING GLASS TYPE-TO-CHAT INPUT CAPSULE ── */}
      <form onSubmit={handleSend} className="pointer-events-auto relative w-full select-auto">
        <div
          ref={inputContainerRef}
          className={`relative flex items-center rounded-2xl border bg-white/[0.04] p-1.5 pl-3.5 backdrop-blur-3xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] transition-all duration-200 ${
            isAutoTyping ? 'border-white/25 bg-white/[0.07]' : 'border-white/[0.08]'
          }`}
        >
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isAutoTyping ? 'Typing prompt...' : 'Type a message to Sera...'}
            disabled={isAutoTyping}
            className="w-full bg-transparent font-sans text-xs text-white placeholder-white/35 outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 border-0 ring-0 pr-2 shadow-none select-none"
          />

          {/* Typing Blinking Caret Indicator */}
          {isAutoTyping && (
            <span
              className="mr-2 h-3.5 w-0.5 animate-typing-caret rounded-full"
              style={{ background: palette.lamp }}
            />
          )}

          {/* Sleek Modern Illuminated Send Button */}
          <button
            type="submit"
            disabled={!inputText.trim() || isAutoTyping}
            className={`group relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl transition-all duration-300 disabled:opacity-20 disabled:pointer-events-none active:scale-90 border ${
              inputText.trim()
                ? 'border-white/20 bg-white/10 hover:bg-white/20 hover:scale-105'
                : 'border-transparent bg-transparent text-white/25'
            } ${isSendingPulse ? 'scale-110' : ''}`}
            style={{
              borderColor: inputText.trim() ? `${palette.lamp}60` : 'transparent',
              background: inputText.trim() ? `${palette.lamp}25` : 'transparent',
              color: inputText.trim() ? palette.lamp : 'rgba(255,255,255,0.25)',
              boxShadow: inputText.trim() ? `0 0 16px ${palette.lamp}40` : 'none',
            }}
            title="Send message (Enter)"
          >
            <ArrowUp className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-0.5" />
          </button>
        </div>

        {/* Sub-hint caption */}
        <div className="mt-1 flex items-center justify-between px-2 font-mono text-[9px] text-white/30">
          <span>↵ Enter to send</span>
          <span
            className="flex items-center gap-1 hover:text-white/60 cursor-pointer"
            onClick={onOpenFullHistory}
          >
            <CornerDownLeft className="h-2.5 w-2.5" /> Live stream · View full history
          </span>
        </div>
      </form>
    </aside>
  );
});
