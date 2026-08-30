import { describe, it, expect, afterEach, vi } from 'vitest';
import { HardwareInspector, parseNvidiaSmiCsv, parseCudaCapability } from '../local/HardwareInspector';
import { recommendLocalModel, LOCAL_MODEL_CATALOG } from '../local/ModelRecommender';
import { OllamaClient } from '../local/OllamaClient';
import { wrapWavHeader } from '../local/LocalSpeechEngines';
import { toOllamaToolDeclarations } from '../local/LocalAgentEngine';
import { ToolManager } from '../tools/ToolManager';
import { ToolDefinition, ToolPermissionLevel } from '../tools/types';
import { hashEmbed, cosineSimilarity, semanticScore } from '../memory/SemanticIndex';

/* ────────────────────────────────────────────────────────────────── */
/* HardwareInspector                                                   */
/* ────────────────────────────────────────────────────────────────── */

describe('parseNvidiaSmiCsv', () => {
  it('parses a standard RTX 4050 row', () => {
    const gpu = parseNvidiaSmiCsv('NVIDIA GeForce RTX 4050 Laptop GPU, 6144 MiB, 5412 MiB, 551.61\n');
    expect(gpu).not.toBeNull();
    expect(gpu!.name).toContain('RTX 4050');
    expect(gpu!.vramTotalMB).toBe(6144);
    expect(gpu!.vramFreeMB).toBe(5412);
    expect(gpu!.driverVersion).toBe('551.61');
    expect(gpu!.cudaSupported).toBe(true);
  });

  it('returns null for unparsable output', () => {
    expect(parseNvidiaSmiCsv('nvidia-smi: command failed')).toBeNull();
    expect(parseNvidiaSmiCsv('')).toBeNull();
    expect(parseNvidiaSmiCsv('name, memory.total [MiB], memory.free [MiB], driver_version')).toBeNull();
  });
});

describe('parseCudaCapability', () => {
  it('extracts CUDA version from nvidia-smi -q output', () => {
    expect(parseCudaCapability('|  CUDA Version : 12.4  |')).toBe('12.4');
    expect(parseCudaCapability('no cuda here')).toBeNull();
  });
});

describe('HardwareInspector.audit', () => {
  it('audits gracefully when nvidia-smi is unavailable', async () => {
    const failingRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: 'not found' });
    const inspector = new HardwareInspector(failingRunner);
    const report = await inspector.audit();
    expect(report.cpu.logicalCores).toBeGreaterThan(0);
    expect(report.ram.totalMB).toBeGreaterThan(0);
    expect(report.gpu).toBeNull();
    expect(report.tier).toBe('cpu-only');
    expect(report.probeNotes.length).toBeGreaterThan(0);
  });

  it('detects a CUDA-high tier on a 6GB RTX 4050', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'NVIDIA GeForce RTX 4050 Laptop GPU, 6144 MiB, 5412 MiB, 551.61\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '|  CUDA Version : 12.4  |', stderr: '' });
    const inspector = new HardwareInspector(runner);
    const report = await inspector.audit();
    expect(report.tier).toBe('cuda-high');
    expect(report.gpu?.cudaComputeCapability).toBe('12.4');
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* ModelRecommender                                                    */
/* ────────────────────────────────────────────────────────────────── */

describe('recommendLocalModel', () => {
  const baseReport = (overrides: Partial<Parameters<typeof recommendLocalModel>[0]> = {}) => ({
    platform: 'win32',
    osRelease: '11',
    arch: 'x64',
    hostname: 'test',
    cpu: { model: 'Intel i7', logicalCores: 16, physicalCores: 8, speedGHz: 4.5 },
    ram: { totalMB: 32768, freeMB: 16384 },
    gpu: {
      name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
      vramTotalMB: 6144,
      vramFreeMB: 5412,
      driverVersion: '551.61',
      cudaComputeCapability: '12.4',
      cudaSupported: true,
    },
    tier: 'cuda-high' as const,
    auditedAt: Date.now(),
    probeNotes: [],
    ...overrides,
  });

  it('recommends qwen2.5:7b on an RTX 4050 6GB with llama3.2:3b alternative', () => {
    const rec = recommendLocalModel(baseReport());
    expect(rec.model).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(rec.budget.fitsInVram).toBe(true);
    expect(rec.alternative?.model).toBe('llama3.2:3b-instruct-q4_K_M');
  });

  it('falls back to llama3.2:3b when only ~2.7GB is free', () => {
    const rec = recommendLocalModel(baseReport({
      tier: 'cuda-low',
      gpu: {
        name: 'NVIDIA MX330', vramTotalMB: 4096, vramFreeMB: 2700,
        driverVersion: '550.00', cudaComputeCapability: '12.1', cudaSupported: true,
      },
    }));
    expect(rec.model).toBe('llama3.2:3b-instruct-q4_K_M');
  });

  it('picks the ultra-light model when free VRAM is tiny', () => {
    const rec = recommendLocalModel(baseReport({
      tier: 'cuda-low',
      gpu: {
        name: 'NVIDIA MX330', vramTotalMB: 2048, vramFreeMB: 1500,
        driverVersion: '550.00', cudaComputeCapability: '12.1', cudaSupported: true,
      },
    }));
    expect(rec.model).toBe('qwen2.5:1.5b-instruct-q4_K_M');
    expect(rec.budget.fitsInVram).toBe(true);
  });

  it('falls back to CPU-only path honestly when no GPU exists', () => {
    const rec = recommendLocalModel(baseReport({ tier: 'cpu-only', gpu: null }));
    expect(rec.budget.cpuFallback).toBe(true);
    expect(rec.rationale).toMatch(/CPU/i);
  });

  it('never recommends a model outside the catalog', () => {
    const rec = recommendLocalModel(baseReport());
    expect(LOCAL_MODEL_CATALOG.some((m) => m.id === rec.model)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* OllamaClient                                                        */
/* ────────────────────────────────────────────────────────────────── */

describe('OllamaClient', () => {
  it('reports not-running when the daemon is unreachable', async () => {
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:59999' });
    const status = await client.status();
    expect(status.running).toBe(false);
    expect(status.installHint).toMatch(/ollama/i);
  });

  it('normalizes string tool-call arguments', async () => {
    // Access a private method via any-cast for a focused unit test.
    const client = new OllamaClient();
    const normalize = (client as unknown as { normalizeArguments(raw: unknown): Record<string, unknown> }).normalizeArguments.bind(client);
    expect(normalize('{"application":"Calc"}')).toEqual({ application: 'Calc' });
    expect(normalize(undefined)).toEqual({});
    expect(normalize({ a: 1 })).toEqual({ a: 1 });
    expect(normalize('not json')).toEqual({ value: 'not json' });
  });

  it('pullModel surfaces connection errors as failed results', async () => {
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:59999' });
    const events: Array<{ status: string; error?: string }> = [];
    const result = await client.pullModel('llama3.2:3b', (e) => events.push(e));
    expect(result.success).toBe(false);
    expect(events.some((e) => e.status === 'error')).toBe(true);
  });
});

describe('OllamaClient.status detection matrix', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats a reachable daemon as installed+running even when the CLI binary is missing (Windows stale-PATH case)', async () => {
    // Regression: the old status() short-circuited on "CLI not found" and
    // never probed the daemon — Local Mode reported "not detected" while
    // http://127.0.0.1:11434 was actually serving inference.
    vi.spyOn(OllamaClient.prototype, 'isInstalled').mockResolvedValue({ installed: false, version: null, hint: 'install ollama' });
    vi.spyOn(OllamaClient.prototype, 'isRunning').mockResolvedValue(true);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:59999' });
    const status = await client.status();
    expect(status.running).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.probeNotes.some((n) => /running daemon is enough/i.test(n))).toBe(true);
  });

  it('reports honest not-installed/not-running when both probes fail', async () => {
    vi.spyOn(OllamaClient.prototype, 'isInstalled').mockResolvedValue({ installed: false, version: null, hint: 'h' });
    vi.spyOn(OllamaClient.prototype, 'isRunning').mockResolvedValue(false);
    const client = new OllamaClient();
    const status = await client.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.probeNotes.some((n) => /Neither the CLI nor a local daemon/i.test(n))).toBe(true);
  });

  it('reports installed-but-stopped when the CLI exists and the daemon is down', async () => {
    vi.spyOn(OllamaClient.prototype, 'isInstalled').mockResolvedValue({ installed: true, version: '0.5.7', hint: 'h' });
    vi.spyOn(OllamaClient.prototype, 'isRunning').mockResolvedValue(false);
    const client = new OllamaClient();
    const status = await client.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.probeNotes.some((n) => /Daemon NOT reachable/i.test(n))).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* Local speech helpers                                                */
/* ────────────────────────────────────────────────────────────────── */

describe('wrapWavHeader', () => {
  it('prepends a valid 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.alloc(1600, 0);
    const wav = wrapWavHeader(pcm, 16000);
    expect(wav.length).toBe(1644);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(1600);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* toOllamaToolDeclarations                                            */
/* ────────────────────────────────────────────────────────────────── */

describe('toOllamaToolDeclarations', () => {
  it('converts Gemini-style tool schemas to Ollama function format', () => {
    const manager = new ToolManager();
    const tool: ToolDefinition<any, any> = {
      name: 'searchWeb',
      description: 'Search the web',
      permissionLevel: ToolPermissionLevel.READ_ONLY,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'the search query' },
          limit: { type: 'INTEGER' },
        },
        required: ['query'],
      },
      validateArgs: (args) => ({ valid: true, parsedArgs: args }),
      execute: async () => ({ success: true }),
    };
    manager.registerTool(tool);

    const declarations = toOllamaToolDeclarations(manager) as Array<{
      type: string;
      function: { name: string; parameters: { type: string; properties: Record<string, { type: string }>; required: string[] } };
    }>;
    expect(declarations.length).toBe(1);
    expect(declarations[0].type).toBe('function');
    expect(declarations[0].function.name).toBe('searchWeb');
    expect(declarations[0].function.parameters.type).toBe('object');
    expect(declarations[0].function.parameters.properties.query.type).toBe('string');
    expect(declarations[0].function.parameters.required).toEqual(['query']);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* SemanticIndex                                                       */
/* ────────────────────────────────────────────────────────────────── */

describe('SemanticIndex', () => {
  it('gives identical text a maximal score', () => {
    expect(semanticScore('user birthday is may 5th', 'user birthday is may 5th')).toBeGreaterThan(0.9);
  });

  it('scores fuzzy/typo variants higher than unrelated text', () => {
    const fuzzy = semanticScore('when was i borth', 'user date of birth is 1998-05-01');
    const unrelated = semanticScore('when was i borth', 'favorite color is teal');
    expect(fuzzy).toBeGreaterThan(unrelated);
  });

  it('produces deterministic normalized embeddings', () => {
    const a = hashEmbed('hello world');
    const b = hashEmbed('hello world');
    expect(a).toEqual(b);
    expect(Math.abs(cosineSimilarity(a, b) - 1)).toBeLessThan(1e-6);
  });
});
