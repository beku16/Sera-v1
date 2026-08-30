/**
 * SERA — ProviderRegistry: the centralized provider/model catalog.
 *
 * Single source of truth for every brain SERA can use: local Ollama models,
 * documented free-tier cloud providers, and paid providers (shipped DISABLED
 * — SERA never spends money unless the user explicitly flips that switch).
 *
 * Design rules (per spec):
 *  - Provider logic lives in adapters, never inline in the app. This registry
 *    only DESCRIBES providers; it never talks HTTP itself.
 *  - Providers can be added/removed/enabled/disabled/updated/tested/
 *    prioritized without touching the engine.
 *  - Free status is honest: 'vendor_documented' seeds carry a "verify terms"
 *    hint; anything 'unverified' is treated as possibly costing money.
 *  - User overrides persist to sera_providers.json (cwd, gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_MODEL_CATALOG } from '../local/ModelRecommender';
import { stateDir } from '../local/SERAPaths';
import type {
  CapabilityMatrix,
  ModelDescriptor,
  ProviderDescriptor,
  ProviderType,
  RoutingMode,
} from './types';

export interface ProviderOverrides {
  enabled?: boolean;
  priority?: number;
  trustedForPrivate?: boolean;
  freeTier?: ProviderDescriptor['freeTier'];
  /** v1.6.11: persisted explicit authorization for paid providers. */
  userAuthorized?: boolean;
}

export interface RegistryPersistence {
  routingMode: RoutingMode;
  providers: Record<string, ProviderOverrides>;
  customProviders: ProviderDescriptor[];
  updatedAt: string;
}

const CAPS = (
  fast: number,
  reasoning: number,
  coding: number,
  vision: number,
  tools: number,
  long: number,
  extra?: Partial<CapabilityMatrix>,
): CapabilityMatrix => ({
  fast_response: fast,
  reasoning,
  coding,
  vision,
  tool_calling: tools,
  long_context: long,
  multimodal: vision > 0 ? Math.min(10, vision) : 0,
  stt: 0,
  tts: 0,
  summarization: Math.max(4, reasoning - 1),
  translation: Math.max(4, reasoning - 1),
  ...extra,
});

function capsToModel(
  id: string,
  label: string,
  caps: CapabilityMatrix,
  contextWindow: number,
  latencyClass: ModelDescriptor['latencyClass'],
): ModelDescriptor {
  return {
    id,
    label,
    caps,
    contextWindow,
    supportsTools: caps.tool_calling > 0,
    supportsVision: caps.vision > 0,
    supportsStreaming: true,
    latencyClass,
  };
}

/** Local Ollama models, mapped from the existing ModelRecommender catalog. */
function seedOllamaModels(): ModelDescriptor[] {
  const capBySpeed: Record<string, CapabilityMatrix> = {
    lightning: CAPS(10, 3, 4, 0, 5, 3),
    fast: CAPS(8, 4, 5, 0, 6, 4),
    balanced: CAPS(5, 6, 7, 0, 7, 5),
  };
  return LOCAL_MODEL_CATALOG.map((spec) =>
    capsToModel(
      spec.id,
      spec.label,
      capBySpeed[spec.speedClass] ?? capBySpeed.balanced,
      spec.contextWindow,
      spec.speedClass === 'lightning' ? 'lightning' : spec.speedClass === 'fast' ? 'fast' : 'moderate',
    ),
  );
}

/**
 * SEED CATALOG — accurate at time of writing, never treated as permanent
 * truth. Free tiers can change; the UI always shows a "verify current
 * terms" hint for cloud providers.
 */
function seedProviders(): ProviderDescriptor[] {
  return [
    {
      id: 'ollama',
      name: 'Ollama (local)',
      type: 'local',
      endpoint: 'http://127.0.0.1:11434',
      authMethod: 'none',
      models: seedOllamaModels(),
      enabled: true,
      priority: 0,
      freeTier: 'vendor_documented',
      trustedForPrivate: true,
      userAuthorized: true,
      notes: 'Runs fully on your machine. Private by design; works offline.',
    },
    {
      id: 'groq',
      name: 'Groq (free tier)',
      type: 'free',
      endpoint: 'https://api.groq.com/openai/v1',
      authMethod: 'bearer',
      keyProviderId: 'groq',
      models: [
        capsToModel('llama-3.3-70b-versatile', 'Llama 3.3 70B', CAPS(8, 8, 8, 0, 8, 6), 131072, 'fast'),
        capsToModel('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', CAPS(10, 5, 5, 0, 7, 5), 131072, 'lightning'),
      ],
      enabled: true,
      priority: 1,
      freeTier: 'vendor_documented',
      trustedForPrivate: false,
      userAuthorized: false,
      notes: 'Documented free tier with rate limits — verify current terms.',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter (:free models)',
      type: 'free',
      endpoint: 'https://openrouter.ai/api/v1',
      authMethod: 'bearer',
      keyProviderId: 'openrouter',
      models: [
        capsToModel('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', CAPS(7, 8, 7, 0, 6, 6), 65536, 'fast'),
        capsToModel('google/gemini-2.0-flash-exp:free', 'Gemini 2.0 Flash Exp (free)', CAPS(9, 7, 6, 8, 6, 8), 1048576, 'fast'),
      ],
      enabled: true,
      priority: 2,
      freeTier: 'vendor_documented',
      trustedForPrivate: false,
      userAuthorized: false,
      notes: 'Only :free model variants are used. Rate limits apply — verify current terms.',
    },
    {
      id: 'gemini',
      name: 'Google AI Studio (free tier)',
      type: 'free',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      authMethod: 'x-goog-api-key',
      keyProviderId: 'gemini',
      models: [
        capsToModel('gemini-2.0-flash', 'Gemini 2.0 Flash', CAPS(9, 7, 7, 9, 9, 9), 1048576, 'fast'),
        capsToModel('gemini-2.5-flash', 'Gemini 2.5 Flash', CAPS(8, 8, 8, 9, 9, 9), 1048576, 'fast'),
      ],
      enabled: true,
      priority: 1,
      freeTier: 'vendor_documented',
      trustedForPrivate: false,
      userAuthorized: false,
      notes: 'Free tier available in AI Studio — verify current terms.',
    },
    {
      id: 'openai',
      name: 'OpenAI (paid)',
      type: 'paid',
      endpoint: 'https://api.openai.com/v1',
      authMethod: 'bearer',
      keyProviderId: 'openai',
      models: [
        capsToModel('gpt-4o-mini', 'GPT-4o mini', CAPS(8, 7, 8, 8, 9, 6), 128000, 'fast'),
        capsToModel('gpt-4o', 'GPT-4o', CAPS(7, 9, 8, 9, 9, 6), 128000, 'moderate'),
      ],
      enabled: false,
      priority: 10,
      freeTier: 'unverified',
      trustedForPrivate: false,
      userAuthorized: false,
      notes: 'Costs money per request. Stays OFF unless you enable paid providers.',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek (paid)',
      type: 'paid',
      endpoint: 'https://api.deepseek.com/v1',
      authMethod: 'bearer',
      keyProviderId: 'deepseek',
      models: [
        capsToModel('deepseek-chat', 'DeepSeek Chat', CAPS(7, 8, 9, 0, 8, 5), 65536, 'moderate'),
      ],
      enabled: false,
      priority: 11,
      freeTier: 'unverified',
      trustedForPrivate: false,
      userAuthorized: false,
      notes: 'Costs money per request. Stays OFF unless you enable paid providers.',
    },
  ];
}

function defaultPersistence(): RegistryPersistence {
  return { routingMode: 'free_first', providers: {}, customProviders: [], updatedAt: new Date().toISOString() };
}

export class ProviderRegistry {
  private seeds: ProviderDescriptor[];
  private overrides: Record<string, ProviderOverrides> = {};
  private customProviders: ProviderDescriptor[] = [];
  private routingModeValue: RoutingMode = 'free_first';
  private readonly file: string;

  constructor(dataDir: string = stateDir()) {
    this.file = path.join(dataDir, 'sera_providers.json');
    this.seeds = seedProviders();
    this.load();
  }

  /* -- persistence ---------------------------------------------------------- */
  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RegistryPersistence>;
      if (raw.providers && typeof raw.providers === 'object') this.overrides = raw.providers;
      if (Array.isArray(raw.customProviders)) this.customProviders = raw.customProviders;
      if (raw.routingMode) this.routingModeValue = raw.routingMode;
    } catch {
      // Corrupt file — fall back to seeds rather than failing the app.
      this.overrides = {};
      this.customProviders = [];
    }
  }

  private save(): void {
    try {
      const payload: RegistryPersistence = {
        routingMode: this.routingModeValue,
        providers: this.overrides,
        customProviders: this.customProviders,
        updatedAt: new Date().toISOString(),
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* best-effort persistence; in-memory state still authoritative */
    }
  }

  /* -- queries ---------------------------------------------------------------- */
  /** All providers with user overrides applied. */
  list(): ProviderDescriptor[] {
    const overridden = this.seeds.map((p) => this.applyOverrides(p));
    return [...overridden, ...this.customProviders.map((p) => ({ ...p }))];
  }

  get(id: string): ProviderDescriptor | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  get routingMode(): RoutingMode {
    return this.routingModeValue;
  }

  enabledProviders(): ProviderDescriptor[] {
    return this.list().filter((p) => p.enabled);
  }

  /* -- mutations (spec: ADD/REMOVE/ENABLE/DISABLE/UPDATE/PRIORITIZE) ----------- */
  setEnabled(id: string, enabled: boolean): boolean {
    const provider = this.get(id);
    if (!provider) return false;
    if (this.seeds.some((p) => p.id === id)) {
      this.overrides[id] = { ...this.overrides[id], enabled };
      // v1.6.11 FIX: enabling a PAID provider IS the explicit user
      // authorization the ModelRouter gate checks (`userAuthorized`). The
      // old code set `enabled: true` but never the authorization flag — a
      // paid provider could be enabled, pass the global "Allow paid
      // providers" switch, and STILL be rejected with "paid provider not
      // explicitly authorized" forever. Disabling revokes the authorization
      // (never spend silently).
      if (provider.type === 'paid') {
        this.overrides[id].userAuthorized = enabled;
      }
    } else {
      const idx = this.customProviders.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      this.customProviders[idx] = { ...this.customProviders[idx], enabled, userAuthorized: true };
    }
    this.save();
    return true;
  }

  setPriority(id: string, priority: number): boolean {
    if (this.seeds.some((p) => p.id === id)) {
      this.overrides[id] = { ...this.overrides[id], priority };
    } else {
      const idx = this.customProviders.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      this.customProviders[idx] = { ...this.customProviders[idx], priority };
    }
    this.save();
    return true;
  }

  setTrustedForPrivate(id: string, trusted: boolean): boolean {
    if (this.seeds.some((p) => p.id === id)) {
      this.overrides[id] = { ...this.overrides[id], trustedForPrivate: trusted };
    } else {
      const idx = this.customProviders.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      this.customProviders[idx] = { ...this.customProviders[idx], trustedForPrivate: trusted };
    }
    this.save();
    return true;
  }

  setRoutingMode(mode: RoutingMode): void {
    this.routingModeValue = mode;
    this.save();
  }

  /** Add or replace a user-hosted / OpenAI-compatible provider. */
  upsertCustomProvider(descriptor: Omit<ProviderDescriptor, 'userAuthorized'> & { userAuthorized?: boolean }): ProviderDescriptor {
    const clean: ProviderDescriptor = { ...descriptor, userAuthorized: true };
    const idx = this.customProviders.findIndex((p) => p.id === clean.id);
    if (idx >= 0) this.customProviders[idx] = clean;
    else this.customProviders.push(clean);
    this.save();
    return { ...clean };
  }

  removeCustomProvider(id: string): boolean {
    const before = this.customProviders.length;
    this.customProviders = this.customProviders.filter((p) => p.id !== id);
    const changed = this.customProviders.length !== before;
    if (changed) this.save();
    return changed;
  }

  /* -- helpers ------------------------------------------------------------------ */
  private applyOverrides(p: ProviderDescriptor): ProviderDescriptor {
    const o = this.overrides[p.id];
    if (!o) return { ...p };
    // v1.6.11: userAuthorized is applied too — without this line the
    // authorization set in setEnabled never reached the router.
    return {
      ...p,
      enabled: o.enabled ?? p.enabled,
      priority: o.priority ?? p.priority,
      trustedForPrivate: o.trustedForPrivate ?? p.trustedForPrivate,
      freeTier: o.freeTier ?? p.freeTier,
      userAuthorized: o.userAuthorized ?? p.userAuthorized,
    };
  }
}
