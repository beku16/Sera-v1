import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2, Send, ExternalLink, Activity, MessageSquare, Copy, Check, Sparkles, Terminal } from 'lucide-react';
import { ToolCallLogItem, TranscriptItem } from '../../types';
import { writeClipboard } from '../../utils/clipboard';

interface TranscriptDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  transcripts: TranscriptItem[];
  toolLogs: ToolCallLogItem[];
  onSendMessage: (text: string) => void;
  onClearHistory: () => void;
  isConnected: boolean;
  /** Tab to show when the drawer opens (defaults to CAPTIONS). */
  initialTab?: 'transcripts' | 'tools';
}

const PROMPT_SUGGESTIONS = [
  'Search the web for latest AI news',
  'Change theme to Cosmic Indigo',
  'Remember that I prefer concise answers',
  'Open YouTube in the browser',
];

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export const TranscriptDrawer: React.FC<TranscriptDrawerProps> = ({
  isOpen,
  onClose,
  transcripts,
  toolLogs,
  onSendMessage,
  onClearHistory,
  isConnected,
  initialTab = 'transcripts',
}) => {
  const [textInput, setTextInput] = useState('');
  const [activeTab, setActiveTab] = useState<'transcripts' | 'tools'>(initialTab);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Each open honors the requested tab — e.g. the chat's TOOL ACTIVITY
  // pill opens the drawer straight onto the TOOLS log.
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  // Auto-scroll to bottom when transcripts arrive
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [transcripts, toolLogs, activeTab]);

  if (!isOpen) return null;

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    onSendMessage(textInput);
    setTextInput('');
  };

  const handleCopy = async (id: string, text: string) => {
    // Same fix as ChatStream: only confirm when the clipboard write truly
    // succeeded (layered fallbacks), never fake the checkmark.
    if (await writeClipboard(text)) setCopiedId(id);
    else console.warn('[TranscriptDrawer] clipboard write failed for message', id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const tabBase =
    'rounded-xl px-3.5 py-1.5 font-mono text-xs tracking-[0.14em] transition-all duration-200';
  const tabActive = 'border border-line bg-paper text-ink shadow-sm font-semibold';
  const tabIdle = 'border border-transparent text-graphite hover:text-ink';

  return (
    <div
      id="sera-transcript-drawer-overlay"
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm animate-fade-up"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="sera-transcript-drawer"
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#0c1018] shadow-[0_0_64px_rgba(0,0,0,0.8)] transition-transform"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveTab('transcripts')}
              className={`${tabBase} ${activeTab === 'transcripts' ? tabActive : tabIdle} inline-flex items-center gap-2`}
            >
              <MessageSquare className="h-3.5 w-3.5 text-graphite" />
              CAPTIONS
              <span className="opacity-60">· {transcripts.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('tools')}
              className={`${tabBase} ${activeTab === 'tools' ? tabActive : tabIdle} inline-flex items-center gap-2`}
            >
              <Activity className="h-3.5 w-3.5 text-graphite" />
              TOOLS
              <span className="opacity-60">· {toolLogs.length}</span>
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClearHistory}
              title="Clear transcript history"
              aria-label="Clear transcript history"
              className="rounded-lg p-2 text-graphite transition-colors hover:bg-paper hover:text-ink active:scale-95"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-graphite transition-colors hover:bg-paper hover:text-ink active:scale-95"
              aria-label="Close drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content Stream */}
        <div ref={scrollContainerRef} className="sera-scroll flex-1 overflow-y-auto p-4">
          {activeTab === 'transcripts' ? (
            transcripts.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-paper text-graphite mb-3">
                  <Sparkles className="h-6 w-6 text-faint" />
                </div>
                <p className="font-serif italic text-[17px] leading-relaxed text-ink">Say something — I&apos;m listening.</p>
                <p className="mt-2 max-w-xs font-mono text-[11px] leading-relaxed text-graphite">
                  Speak naturally and both your words and Sera&apos;s responses will stream here in real time.
                </p>

                {/* Prompt Suggestions */}
                <div className="mt-6 flex flex-col gap-2 w-full max-w-xs">
                  <span className="font-mono text-[10px] tracking-[0.16em] text-faint text-left">QUICK PROMPTS:</span>
                  {PROMPT_SUGGESTIONS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => onSendMessage(prompt)}
                      className="rounded-xl border border-line bg-paper px-3 py-2 text-left font-mono text-xs text-ink transition hover:border-line-strong hover:bg-panel active:scale-[0.98]"
                    >
                      &quot;{prompt}&quot;
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3.5">
                {transcripts.map((t) => {
                  const isUser = t.sender === 'user';
                  return (
                    <div
                      key={t.id}
                      className={
                        isUser
                          ? 'group relative ml-auto max-w-[86%] rounded-2xl border border-line bg-paper px-3.5 py-3 shadow-sm'
                          : 'group relative mr-auto max-w-[88%] rounded-2xl border border-line bg-panel/70 px-3.5 py-3 shadow-sm'
                      }
                      style={!isUser ? { borderLeftWidth: '3px', borderLeftColor: 'var(--lamp, var(--color-lamp))' } : undefined}
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.16em] text-graphite">
                        <span className="font-bold text-ink">{isUser ? (t.speakerName ? `YOU (${t.speakerName})` : 'YOU') : 'SERA'}</span>
                        <div className="flex items-center gap-2">
                          <span className="opacity-60">{formatTime(t.timestamp)}</span>
                          <button
                            type="button"
                            onClick={() => handleCopy(t.id, t.text)}
                            title="Copy message"
                            aria-label="Copy message"
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-graphite hover:text-ink"
                          >
                            {copiedId === t.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                          </button>
                        </div>
                      </div>
                      <p
                        className={
                          isUser
                            ? 'font-mono text-xs leading-relaxed text-ink'
                            : 'font-serif text-[15px] leading-relaxed italic text-ink'
                        }
                      >
                        {t.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            )
          ) : toolLogs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-paper text-graphite mb-3">
                <Terminal className="h-6 w-6 text-faint" />
              </div>
              <p className="font-mono text-xs font-semibold tracking-[0.14em] text-ink">NO TOOL ACTIONS RECORDED</p>
              <p className="mt-1.5 max-w-xs font-mono text-[11px] leading-relaxed text-graphite">
                When Sera executes system tools, web searches, or browser automations, verifiable outputs will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {toolLogs.map((tool) => (
                <div
                  key={tool.id}
                  className="rounded-2xl border border-line bg-paper p-3.5 shadow-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 font-mono text-xs font-semibold text-ink">
                      <Activity className="h-3.5 w-3.5 text-graphite" />
                      {tool.name}
                    </span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 font-mono text-[9px] font-bold tracking-[0.12em] ${
                        tool.status === 'success'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : tool.status === 'failed' || tool.status === 'rejected'
                          ? 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                          : 'border-line bg-panel text-graphite'
                      }`}
                    >
                      {tool.status.toUpperCase()}
                    </span>
                  </div>

                  {tool.args && Object.keys(tool.args).length > 0 && (
                    <pre className="sera-scroll mt-2.5 overflow-x-auto rounded-xl border border-line bg-bg p-2.5 font-mono text-[11px] leading-relaxed text-ink-soft">
                      {JSON.stringify(tool.args, null, 2)}
                    </pre>
                  )}

                  {tool.result && typeof tool.result === 'object' && (tool.result as { url?: string }).url && (
                    <a
                      href={(tool.result as { url: string }).url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2.5 inline-flex items-center gap-1.5 font-mono text-xs text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open {(tool.result as { domain?: string }).domain || 'target page'}
                    </a>
                  )}

                  {tool.error && <p className="mt-2 font-mono text-[11px] text-rose-500">{tool.error}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Text Input Composer */}
        <form onSubmit={handleSend} className="border-t border-line bg-panel p-3.5">
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-paper px-3.5 py-2 focus-within:border-line-strong shadow-sm">
            <input
              type="text"
              placeholder={isConnected ? 'Type message to Sera…' : 'Connect session to send text…'}
              disabled={!isConnected}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="flex-1 bg-transparent font-mono text-xs text-ink placeholder:text-faint focus:outline-none disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!isConnected || !textInput.trim()}
              className="flex h-7 w-7 items-center justify-center rounded-xl bg-ink text-paper transition hover:opacity-90 active:scale-95 disabled:opacity-30"
              aria-label="Send text prompt"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
