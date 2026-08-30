import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { seraEnginesDir, seraModelsDir, seraVoicesDir } from './EngineHome';

/**
 * Local speech engine availability + orchestration.
 *
 * SERA ships with three tiers of offline speech:
 *  1. Electron speech-host (Windows SAPI bridge — already wired via
 *     electron/local-speech.ps1) used in desktop builds.
 *  2. whisper.cpp STT + Piper TTS binaries when present on PATH or in
 *     the engines directory.
 *  3. Browser Web Speech API (client-side) as the universal fallback.
 *
 * This module implements tier 2 with honest availability probing: when a
 * binary is missing the engine reports `available: false` and explains
 * how to install it, rather than failing mid-conversation.
 */

export interface EngineAvailability {
  available: boolean;
  /** Which engine resolved (binary path or built-in id). */
  resolvedWith: string | null;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Whisper STT                                                         */
/* ------------------------------------------------------------------ */

export interface WhisperTranscribeResult {
  success: boolean;
  text: string;
  error?: string;
}

// v1.6.9: candidates now lead with the PERSISTENT SERA home directory
// (~/.sera — survives every update/clone/build), then the legacy
// repo-relative paths, then PATH lookups.
const WHISPER_CANDIDATES = [
  process.env.SERA_WHISPER_BIN,
  path.join(seraEnginesDir(), 'whisper-cli.exe'),
  path.join(seraEnginesDir(), 'whisper-cli'),
  path.join(seraEnginesDir(), 'main.exe'),
  'whisper-cli',
  'whisper.cpp/main',
  'main.exe',
].filter(Boolean) as string[];

const WHISPER_MODEL_CANDIDATES = [
  process.env.SERA_WHISPER_MODEL,
  path.join(seraModelsDir(), 'ggml-base.en.bin'),
  path.join(seraModelsDir(), 'ggml-small.bin'),
  'models/ggml-base.en.bin',
  'models/ggml-small.bin',
].filter(Boolean) as string[];

export class LocalWhisperStt {
  private readonly enginesDir: string;

  constructor(enginesDir?: string) {
    // v1.9.0: engines live in the persistent per-user .sera home — never
    // the (possibly read-only) install dir.
    this.enginesDir = enginesDir || seraEnginesDir();
  }

  /**
   * Probes for a usable whisper.cpp binary + model pair.
   */
  public availability(): EngineAvailability {
    for (const bin of WHISPER_CANDIDATES) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        for (const model of WHISPER_MODEL_CANDIDATES) {
          try {
            fs.accessSync(model, fs.constants.R_OK);
            return { available: true, resolvedWith: `${bin} + ${model}` };
          } catch {
            continue;
          }
        }
        return {
          available: false,
          resolvedWith: bin,
          hint: `whisper binary found (${bin}) but no ggml model file. Place a ggml-base.en.bin in ./models/ or set SERA_WHISPER_MODEL.`,
        };
      } catch {
        continue;
      }
    }
    return {
      available: false,
      resolvedWith: null,
      hint: 'whisper.cpp not installed. SERA will use browser speech recognition instead. Optional: place whisper-cli + ggml model in the SERA home folder (%USERPROFILE%\\.sera\\engines — survives updates) or ./engines/. A one-time install — never needs redoing after updates.',
    };
  }

  /**
   * Transcribes 16kHz mono PCM16 data through whisper.cpp.
   * Returns success:false (never throws) when the engine is unavailable.
   */
  public async transcribePcm16(pcm16: Buffer): Promise<WhisperTranscribeResult> {
    const availability = this.availability();
    if (!availability.available) {
      return { success: false, text: '', error: availability.hint };
    }

    const [bin] = availability.resolvedWith!.split(' + ');
    const wavPath = path.join(os.tmpdir(), `sera-whisper-${Date.now()}.wav`);
    // v1.6.11: whisper.cpp writes its output to <base>.txt (-otxt -of <base>).
    // That sidecar file was never deleted — one temp file leaked per voice
    // utterance, forever. It is removed in the same finally block as the wav.
    const txtSidecarPath = wavPath.replace(/\.wav$/, '.txt');

    try {
      fs.writeFileSync(wavPath, wrapWavHeader(pcm16, 16000));
      const text = await new Promise<string>((resolve, reject) => {
        const model = WHISPER_MODEL_CANDIDATES.find((m) => {
          try { fs.accessSync(m, fs.constants.R_OK); return true; } catch { return false; }
        }) || 'models/ggml-base.en.bin';

        const child = spawn(bin, ['-m', model, '-f', wavPath, '-nt', '-otxt', '-of', wavPath.replace(/\.wav$/, '')], {
          windowsHide: true,
          timeout: 30000,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += String(d); });
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            // whisper.cpp prints the transcription to stdout with -nt.
            resolve(stdout.trim());
          } else {
            reject(new Error(`whisper.cpp exited ${code}: ${stderr.slice(0, 200)}`));
          }
        });
      });
      return { success: true, text };
    } catch (err) {
      return { success: false, text: '', error: err instanceof Error ? err.message : String(err) };
    } finally {
      for (const tempFile of [wavPath, txtSidecarPath]) {
        try { fs.unlinkSync(tempFile); } catch { /* temp cleanup best-effort */ }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Piper TTS                                                           */
/* ------------------------------------------------------------------ */

export interface PiperSynthesizeResult {
  success: boolean;
  /** Raw PCM16 mono samples at the Piper voice's native rate (22050Hz). */
  pcm16: Buffer | null;
  sampleRate: number;
  error?: string;
}

const PIPER_CANDIDATES = [
  process.env.SERA_PIPER_BIN,
  path.join(seraEnginesDir(), 'piper.exe'),
  path.join(seraEnginesDir(), 'piper'),
  'piper',
  'piper.exe',
].filter(Boolean) as string[];
const PIPER_VOICE_CANDIDATES = [
  process.env.SERA_PIPER_VOICE,
  path.join(seraVoicesDir(), 'en_US-amy-medium.onnx'),
  path.join(seraVoicesDir(), 'en_US-lessac-medium.onnx'),
  'voices/en_US-amy-medium.onnx',
  'voices/en_US-lessac-medium.onnx',
].filter(Boolean) as string[];

export class LocalPiperTts {
  private readonly enginesDir: string;

  constructor(enginesDir?: string) {
    // v1.9.0: engines live in the persistent per-user .sera home — never
    // the (possibly read-only) install dir.
    this.enginesDir = enginesDir || seraEnginesDir();
  }

  /**
   * Probes for a usable piper binary + voice pair.
   */
  public availability(): EngineAvailability {
    for (const bin of PIPER_CANDIDATES) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        for (const voice of PIPER_VOICE_CANDIDATES) {
          try {
            fs.accessSync(voice, fs.constants.R_OK);
            return { available: true, resolvedWith: `${bin} + ${voice}` };
          } catch {
            continue;
          }
        }
        return {
          available: false,
          resolvedWith: bin,
          hint: `piper binary found (${bin}) but no .onnx voice. Download a voice to ./voices/ or set SERA_PIPER_VOICE.`,
        };
      } catch {
        continue;
      }
    }
    return {
      available: false,
      resolvedWith: null,
      hint: 'Piper TTS not installed. SERA auto-installs it on startup when Python/pip is available (stored in %USERPROFILE%\\.sera — one time only, survives updates). SERA will use the browser speech synthesizer until then.',
    };
  }

  /**
   * Synthesizes text to raw PCM16 through piper --output-raw.
   */
  public async synthesize(text: string): Promise<PiperSynthesizeResult> {
    const availability = this.availability();
    if (!availability.available) {
      return { success: false, pcm16: null, sampleRate: 22050, error: availability.hint };
    }
    const [bin] = availability.resolvedWith!.split(' + ');
    const voice = PIPER_VOICE_CANDIDATES.find((v) => {
      try { fs.accessSync(v, fs.constants.R_OK); return true; } catch { return false; }
    }) || PIPER_VOICE_CANDIDATES[0];

    try {
      const pcm = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(bin, ['--model', voice, '--output-raw'], { windowsHide: true, timeout: 30000 });
        const chunks: Buffer[] = [];
        let stderr = '';
        child.stdout?.on('data', (d) => chunks.push(d as Buffer));
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.stdin?.write(text);
        child.stdin?.end();
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`piper exited ${code}: ${stderr.slice(0, 200)}`));
        });
      });
      return { success: true, pcm16: pcm, sampleRate: 22050 };
    } catch (err) {
      return { success: false, pcm16: null, sampleRate: 22050, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Wraps raw PCM16 mono samples in a minimal 44-byte WAV header so
 * whisper.cpp can read them (it only accepts WAV files).
 */
export function wrapWavHeader(pcm16: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM format
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit)
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}
