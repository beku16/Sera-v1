import React from 'react';
import { Mic, Play, Square, Trash2 } from 'lucide-react';
import { defaultSpeakerManager } from '../../speakers';

interface SpeakerRecognitionTabProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export const SpeakerRecognitionTab: React.FC<SpeakerRecognitionTabProps> = ({ enabled, onEnabledChange }) => {
  const [profiles, setProfiles] = React.useState(() => defaultSpeakerManager.listProfiles());
  const [name, setName] = React.useState('');
  const [recording, setRecording] = React.useState(false);
  const [samples, setSamples] = React.useState<Int16Array>(new Int16Array());
  const streamRef = React.useRef<MediaStream | null>(null);
  const contextRef = React.useRef<AudioContext | null>(null);
  const processorRef = React.useRef<ScriptProcessorNode | null>(null);
  const chunksRef = React.useRef<number[]>([]);

  const stopRecording = React.useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    setRecording(false);
    setSamples(new Int16Array(chunksRef.current));
  }, []);

  const startRecording = async () => {
    if (recording) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    chunksRef.current = [];
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (const value of input) chunksRef.current.push(Math.max(-32768, Math.min(32767, Math.round(value * 32767))));
    };
    source.connect(processor);
    processor.connect(context.destination);
    streamRef.current = stream;
    contextRef.current = context;
    processorRef.current = processor;
    setRecording(true);
  };

  const saveProfile = () => {
    const profile = defaultSpeakerManager.enroll(name, samples);
    if (profile) {
      setProfiles(defaultSpeakerManager.listProfiles());
      setName('');
      setSamples(new Int16Array());
    }
  };

  React.useEffect(() => stopRecording, [stopRecording]);

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-xl border border-line bg-paper p-4">
        <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-[0.14em] text-ink">
          <Mic className="h-4 w-4 text-graphite" /> VOICE RECOGNITION
        </div>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-graphite">
          Compact voice prints. Uncertain voices stay unknown.
        </p>
      </div>

      <label className="flex items-center justify-between rounded-xl border border-line bg-paper p-3 font-mono text-xs text-ink">
        <span className="tracking-[0.1em]">SPEAKER RECOGNITION</span>
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} className="h-4 w-4 accent-ink" />
      </label>

      <div className="font-mono text-[11px] tracking-[0.12em] text-graphite">KNOWN PEOPLE · {profiles.length}</div>

      <div className="space-y-3 rounded-xl border border-line bg-paper p-4">
        <label className="block font-mono text-[11px] tracking-[0.12em] text-graphite">
          ADD PERSON
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            className="mt-1 w-full rounded-xl border border-line bg-bg p-2 font-mono text-xs text-ink placeholder:text-faint focus:border-ink-soft focus:outline-none"
          />
        </label>
        <div className="flex gap-2">
          {!recording ? (
            <button type="button" onClick={() => void startRecording()} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-mono text-xs font-semibold tracking-[0.08em] text-paper hover:bg-ink-soft">
              <Play className="h-3.5 w-3.5" /> RECORD
            </button>
          ) : (
            <button type="button" onClick={stopRecording} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 font-mono text-xs text-ink hover:border-ink-soft">
              <Square className="h-3.5 w-3.5" /> STOP
            </button>
          )}
          <button
            type="button"
            disabled={!name.trim() || samples.length < 256 || recording}
            onClick={saveProfile}
            className="rounded-lg bg-ink px-3 py-1.5 font-mono text-xs font-semibold tracking-[0.08em] text-paper hover:bg-ink-soft disabled:opacity-30"
          >
            SAVE
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {profiles.map((profile) => (
          <div key={profile.speakerId} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper p-3">
            <div>
              <div className="font-mono text-xs text-ink">
                {profile.name}
                {profile.isPrimary ? ' · Primary' : ''}
              </div>
              <div className="font-mono text-[10px] capitalize tracking-[0.12em] text-graphite">{profile.permission.replace('_', ' ')}</div>
            </div>
            <span className="flex items-center gap-2">
              <select
                aria-label={`Permission for ${profile.name}`}
                value={profile.permission}
                onChange={(event) => {
                  if (event.target.value === 'full_control') defaultSpeakerManager.setPrimary(profile.speakerId);
                  setProfiles(defaultSpeakerManager.listProfiles());
                }}
                className="rounded-lg border border-line bg-bg p-1 font-mono text-[10px] text-ink focus:border-ink-soft focus:outline-none"
              >
                <option value="conversation">Conversation</option>
                <option value="restricted">Restricted</option>
                <option value="full_control">Primary User</option>
              </select>
              <button type="button" title={`Delete ${profile.name}`} onClick={() => { defaultSpeakerManager.remove(profile.speakerId); setProfiles(defaultSpeakerManager.listProfiles()); }} className="rounded-md p-1.5 text-graphite hover:bg-ink/5 hover:text-ink">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
