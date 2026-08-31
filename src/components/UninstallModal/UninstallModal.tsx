import React, { useState, useEffect, useRef } from 'react';
import {
  AlertTriangle,
  Shield,
  Trash2,
  Lock,
  Volume2,
  CheckCircle2,
  XCircle,
  Database,
  Key,
  BrainCircuit,
  Loader2,
  Mic,
  FolderDown,
  X,
} from 'lucide-react';
import { ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';

interface UninstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  paletteId?: ColorPaletteId;
  customColor?: string;
}

interface UninstallChallenge {
  challengeId: string;
  phrase: string;
  tokens: string[];
}

interface MemorySummary {
  memoryCount: number;
  mistakeCount: number;
  hasVaultKeys: boolean;
  backupPathSuggestion: string;
}

export const UninstallModal: React.FC<UninstallModalProps> = ({
  isOpen,
  onClose,
  paletteId,
  customColor,
}) => {
  const palette = getPaletteConfig(paletteId, customColor);

  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [challenge, setChallenge] = useState<UninstallChallenge | null>(null);
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [userInput, setUserInput] = useState('');
  const [preserveMemory, setPreserveMemory] = useState(true);
  const [preserveEngines, setPreserveEngines] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<'idle' | 'listening' | 'processing' | 'error'>('idle');
  const speechRecognitionRef = useRef<any>(null);
  const desktopUnsubRef = useRef<(() => void) | null>(null);

  // Cleanup speech on unmount or close
  useEffect(() => {
    return () => {
      if (desktopUnsubRef.current) {
        desktopUnsubRef.current();
        desktopUnsubRef.current = null;
      }
      if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch {}
        speechRecognitionRef.current = null;
      }
      if (window.seraDesktop?.stopLocalSpeech) {
        window.seraDesktop.stopLocalSpeech().catch(() => {});
      }
    };
  }, []);

  // Fetch challenge and memory summary on open
  useEffect(() => {
    if (!isOpen) {
      setUserInput('');
      setErrorMessage(null);
      setSuccessMessage(null);
      setExecuting(false);
      setMicStatus('idle');
      if (desktopUnsubRef.current) {
        desktopUnsubRef.current();
        desktopUnsubRef.current = null;
      }
      if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch {}
        speechRecognitionRef.current = null;
      }
      if (window.seraDesktop?.stopLocalSpeech) {
        window.seraDesktop.stopLocalSpeech().catch(() => {});
      }
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    Promise.all([
      fetch('/api/uninstall/challenge')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/uninstall/summary')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([challengeData, summaryData]) => {
        if (challengeData && challengeData.phrase) {
          setChallenge(challengeData);
        }
        if (summaryData) {
          setSummary(summaryData);
        }
      })
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Speech Recognition listener for spoken confirmation (Desktop SAPI + Web Speech API fallback)
  const handleToggleVoiceInput = async () => {
    if (micStatus === 'listening') {
      if (desktopUnsubRef.current) {
        desktopUnsubRef.current();
        desktopUnsubRef.current = null;
      }
      if (window.seraDesktop?.stopLocalSpeech) {
        try { await window.seraDesktop.stopLocalSpeech(); } catch {}
      }
      if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch {}
        speechRecognitionRef.current = null;
      }
      setMicStatus('idle');
      return;
    }

    setErrorMessage(null);
    setMicStatus('listening');

    // 1. Try Desktop Electron Speech Engine (Windows SAPI Bridge)
    if (window.seraDesktop?.startLocalSpeech && window.seraDesktop?.onLocalSpeechTranscript) {
      try {
        const unsubs: Array<() => void> = [];
        const unsubTranscript = window.seraDesktop.onLocalSpeechTranscript((payload) => {
          if (payload?.text && payload.text.trim()) {
            setMicStatus('processing');
            setUserInput(payload.text.trim());
            setTimeout(() => {
              setMicStatus('idle');
              if (desktopUnsubRef.current) {
                desktopUnsubRef.current();
                desktopUnsubRef.current = null;
              }
              window.seraDesktop?.stopLocalSpeech?.().catch(() => {});
            }, 400);
          }
        });
        unsubs.push(unsubTranscript);

        const unsubError = window.seraDesktop.onLocalSpeechError?.((err) => {
          console.warn('[UNINSTALL_VOICE_DESKTOP_ERROR]', err);
          setErrorMessage("Couldn't recognize speech. Try again or type the code.");
          setMicStatus('error');
          if (desktopUnsubRef.current) {
            desktopUnsubRef.current();
            desktopUnsubRef.current = null;
          }
          window.seraDesktop?.stopLocalSpeech?.().catch(() => {});
        });
        if (unsubError) unsubs.push(unsubError);

        desktopUnsubRef.current = () => {
          unsubs.forEach((fn) => fn());
        };

        await window.seraDesktop.startLocalSpeech();
        return;
      } catch (err) {
        console.warn('[UNINSTALL_DESKTOP_SPEECH_START_FAIL]', err);
        // Fall through to browser recognition
      }
    }

    // 2. Fallback to Browser Speech Recognition (Web Speech API)
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRec) {
      try {
        const recognition = new SpeechRec();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
          setMicStatus('listening');
          setErrorMessage(null);
        };

        recognition.onresult = (event: any) => {
          const transcript = Array.from(event.results)
            .map((res: any) => res[0]?.transcript || '')
            .join(' ');
          if (transcript.trim()) {
            setMicStatus('processing');
            setUserInput(transcript.trim());
          }
        };

        recognition.onerror = (err: any) => {
          console.warn('[UNINSTALL_BROWSER_VOICE_ERROR]', err);
          setErrorMessage("Couldn't recognize speech. Try again or type the code.");
          setMicStatus('error');
        };

        recognition.onend = () => {
          setMicStatus('idle');
        };

        speechRecognitionRef.current = recognition;
        recognition.start();
        return;
      } catch (e) {
        console.warn('[UNINSTALL_BROWSER_VOICE_EXCEPTION]', e);
      }
    }

    setErrorMessage('Speech recognition is not supported in this environment. Please type the words.');
    setMicStatus('error');
  };

  // Validation logic
  const isInputValid = (() => {
    if (!challenge) return false;
    const clean = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cleanInput = clean(userInput);
    const cleanTarget = clean(challenge.phrase);
    if (cleanInput === cleanTarget) return true;

    const inputWords = cleanInput.split(' ');
    return challenge.tokens.every((t) => inputWords.includes(t.toLowerCase()));
  })();

  const handleExecuteUninstall = async () => {
    if (!isInputValid || !challenge || executing) return;

    setExecuting(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/uninstall/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          inputPhrase: userInput,
          preserveMemory,
          preserveEngines,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setSuccessMessage(data.message || 'SERA uninstallation initiated.');
      } else {
        setErrorMessage(data.message || data.error || 'Uninstallation failed.');
        setExecuting(false);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Network error initiating uninstallation');
      setExecuting(false);
    }
  };

  const handleExportBackupOnly = async () => {
    try {
      const res = await fetch('/api/uninstall/backup', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Memory backup exported to:\n${data.backupDir}`);
      }
    } catch (err) {
      alert('Failed to export backup.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xl animate-fade-in">
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-red-500/30 bg-[#0d0f17]/95 p-6 text-white shadow-[0_20px_60px_rgba(255,59,92,0.25)] backdrop-blur-2xl"
        style={{
          boxShadow: '0 25px 70px rgba(0, 0, 0, 0.8), 0 0 40px rgba(239, 68, 68, 0.2)',
        }}
      >
        {/* Close Button */}
        {!executing && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-5 right-5 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/50 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Header */}
        <div className="flex items-center gap-3.5 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-500/40 bg-red-500/10 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.3)]">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-mono text-base font-black tracking-wider text-white uppercase">
              SERA Uninstallation & Data Protection
            </h2>
            <p className="text-xs text-white/60">
              Multi-step security challenge to prevent accidental removal
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-white/60">
            <Loader2 className="h-8 w-8 animate-spin text-red-400" />
            <span className="font-mono text-xs tracking-wider">GENERATING SECURITY CHALLENGE...</span>
          </div>
        ) : successMessage ? (
          <div className="flex flex-col items-center justify-center py-10 text-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
              <CheckCircle2 className="h-9 w-9" />
            </div>
            <h3 className="font-mono text-base font-bold text-white">Uninstallation In Progress</h3>
            <p className="text-xs text-white/70 max-w-md leading-relaxed">{successMessage}</p>
            <span className="font-mono text-[11px] text-white/40">SERA will now close automatically...</span>
          </div>
        ) : (
          <div className="flex flex-col gap-5 pt-4">
            {/* Memory & Learning Summary Card */}
            {summary && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3.5">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <BrainCircuit className="h-4 w-4 text-cyan-400" />
                    <span className="font-mono text-xs font-bold text-white tracking-wider">
                      STORED DATA & MEMORY
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleExportBackupOnly}
                    className="flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 font-mono text-[10px] font-bold text-cyan-300 transition hover:bg-cyan-500/20"
                    title="Export a standalone copy of your memories right now"
                  >
                    <FolderDown className="h-3 w-3" />
                    EXPORT BACKUP NOW
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-2.5 text-center">
                  <div className="rounded-xl bg-black/40 p-2 border border-white/[0.04]">
                    <div className="font-mono text-base font-extrabold text-cyan-300">
                      {summary.memoryCount}
                    </div>
                    <div className="font-mono text-[9px] text-white/50 uppercase">Memories</div>
                  </div>
                  <div className="rounded-xl bg-black/40 p-2 border border-white/[0.04]">
                    <div className="font-mono text-base font-extrabold text-emerald-300">
                      {summary.mistakeCount}
                    </div>
                    <div className="font-mono text-[9px] text-white/50 uppercase">Learned Skills</div>
                  </div>
                  <div className="rounded-xl bg-black/40 p-2 border border-white/[0.04]">
                    <div className="font-mono text-base font-extrabold text-amber-300">
                      {summary.hasVaultKeys ? 'Encrypted' : 'None'}
                    </div>
                    <div className="font-mono text-[9px] text-white/50 uppercase">API Vault Keys</div>
                  </div>
                </div>
              </div>
            )}

            {/* Retention Strategy Option */}
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] font-bold tracking-wider text-white/80 uppercase">
                Data Retention Strategy:
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setPreserveMemory(true);
                    setPreserveEngines(true);
                  }}
                  className={`flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition-all ${
                    preserveMemory
                      ? 'border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                      : 'border-white/[0.08] bg-white/[0.02] opacity-60 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-emerald-400" />
                    <span className="font-mono text-xs font-bold text-white">Preserve Memories</span>
                  </div>
                  <p className="text-[10px] text-white/60 leading-relaxed">
                    Saves memories to <code className="text-emerald-300 font-mono">Sera_Memory_Backup</code> so you can reinstall anytime.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setPreserveMemory(false);
                    setPreserveEngines(false);
                  }}
                  className={`flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition-all ${
                    !preserveMemory
                      ? 'border-red-500/50 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.15)]'
                      : 'border-white/[0.08] bg-white/[0.02] opacity-60 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Trash2 className="h-4 w-4 text-red-400" />
                    <span className="font-mono text-xs font-bold text-white">100% Full Wipe</span>
                  </div>
                  <p className="text-[10px] text-white/60 leading-relaxed">
                    Completely deletes all memories, history, caches, and local configurations.
                  </p>
                </button>
              </div>
            </div>

            {/* Security Challenge Box */}
            {challenge && (
              <div className="flex flex-col gap-2 rounded-2xl border border-red-500/30 bg-red-500/[0.04] p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5 text-red-400" />
                    <span className="font-mono text-[11px] font-bold text-red-300 tracking-wider uppercase">
                      Security Confirmation Code
                    </span>
                  </div>
                  <span className="text-[10px] text-white/50">Say or type this phrase</span>
                </div>

                {/* Challenge Word Chips */}
                <div className="flex flex-wrap items-center justify-center gap-2 py-2">
                  {challenge.tokens.map((token, i) => (
                    <span
                      key={i}
                      className="rounded-xl border border-white/20 bg-black/60 px-3.5 py-1.5 font-mono text-sm font-black tracking-widest text-white shadow-inner"
                    >
                      {token}
                    </span>
                  ))}
                </div>

                {/* User Input Field with Microphone Button */}
                <div className="relative flex items-center gap-2">
                  <input
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    placeholder={
                      micStatus === 'listening'
                        ? 'Listening... speak the words above'
                        : 'Type the words above or click mic to speak...'
                    }
                    disabled={executing}
                    className={`w-full rounded-xl border px-3.5 py-2.5 font-mono text-xs text-white focus:outline-none transition-all ${
                      micStatus === 'listening'
                        ? 'border-red-400 bg-red-950/30 placeholder-red-300 animate-pulse'
                        : 'border-white/15 bg-black/50 placeholder-white/30 focus:border-red-400 focus:ring-1 focus:ring-red-400'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={handleToggleVoiceInput}
                    disabled={executing}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all ${
                      micStatus === 'listening'
                        ? 'border-red-400 bg-red-500 text-white shadow-[0_0_15px_rgba(239,68,68,0.6)] animate-pulse'
                        : micStatus === 'processing'
                        ? 'border-cyan-400 bg-cyan-950/40 text-cyan-300'
                        : micStatus === 'error'
                        ? 'border-red-500/40 bg-red-500/10 text-red-400'
                        : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white active:scale-95'
                    }`}
                    title={
                      micStatus === 'listening'
                        ? 'Listening... click to stop'
                        : micStatus === 'processing'
                        ? 'Processing speech...'
                        : 'Click mic to speak the confirmation words'
                    }
                    aria-label="Toggle voice input"
                  >
                    {micStatus === 'processing' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                    ) : (
                      <Mic className={`h-4 w-4 ${micStatus === 'listening' ? 'text-white' : ''}`} />
                    )}
                  </button>
                </div>

                {/* Validation feedback */}
                {userInput.trim() && (
                  <div className="flex items-center gap-1.5 pt-0.5">
                    {isInputValid ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="font-mono text-[10px] font-bold text-emerald-300">
                          Security phrase verified ✓
                        </span>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3.5 w-3.5 text-red-400" />
                        <span className="font-mono text-[10px] text-red-300">
                          Phrase does not match. Please verify the 4 words.
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Error Message */}
            {errorMessage && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300">
                {errorMessage}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={executing}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 font-mono text-xs font-bold text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                CANCEL
              </button>

              <button
                type="button"
                onClick={handleExecuteUninstall}
                disabled={!isInputValid || executing}
                className="group relative flex items-center gap-2 rounded-xl border border-red-500/60 bg-gradient-to-r from-red-600 to-red-700 px-5 py-2 font-mono text-xs font-black tracking-wider text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:shadow-none"
              >
                {executing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>UNINSTALLING...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>CONFIRM & UNINSTALL SERA</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
