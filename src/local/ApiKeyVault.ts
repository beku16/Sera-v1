import crypto from 'node:crypto';
import { vaultDir } from './SERAPaths';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypted API Key Vault for Online Mode (spec section A.1).
 *
 * Keys are encrypted at rest with AES-256-GCM. The encryption key is a
 * random 32-byte secret generated on first use and stored in a keyfile
 * under the SERA data directory (mode 0600). On Windows this is a
 * per-machine secret; combined with GCM integrity it protects the
 * keyfile from casual inspection and tampering.
 */

/**
 * Provider ids the vault can store. 'groq' and 'openrouter' back the
 * free-first orchestration catalog; existing ids are unchanged.
 */
export type ApiProvider = 'gemini' | 'openai' | 'deepseek' | 'groq' | 'openrouter';

export const API_PROVIDERS: Array<{
  id: ApiProvider;
  label: string;
  /** Where the key can be obtained. */
  keyUrl: string;
  /** Endpoint used by the instant connection test. */
  testUrl: string;
  /** Header format for the test request. */
  authHeader: (key: string) => Record<string, string>;
  envVar: string;
}> = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    testUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authHeader: (key) => ({ 'x-goog-api-key': key }),
    envVar: 'GEMINI_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    testUrl: 'https://api.openai.com/v1/models',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    envVar: 'OPENAI_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    testUrl: 'https://api.deepseek.com/v1/models',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    envVar: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'groq',
    label: 'Groq (free tier)',
    keyUrl: 'https://console.groq.com/keys',
    testUrl: 'https://api.groq.com/openai/v1/models',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    envVar: 'GROQ_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    keyUrl: 'https://openrouter.ai/keys',
    testUrl: 'https://openrouter.ai/api/v1/models',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    envVar: 'OPENROUTER_API_KEY',
  },
];

export interface VaultEntry {
  provider: ApiProvider;
  /** Masked preview, e.g. "AIza…9fQk". */
  maskedKey: string;
  updatedAt: number;
  /** Last validation result, if a test was run. */
  lastTest?: { ok: boolean; message: string; testedAt: number };
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export class ApiKeyVault {
  private readonly dataDir: string;
  private readonly vaultFile: string;
  private readonly keyFile: string;
  private encryptionKey: Buffer | null = null;

  constructor(dataDir?: string) {
    // v1.9.0 (BUG L5): the vault used to default to process.cwd() — fine in
    // a repo checkout, catastrophic installed under Program Files (read-only
    // → every key save failed). The authoritative home is now the per-user
    // SERA data dir (%APPDATA%\SERA\vault), with a one-time copy from the
    // legacy location handled by SERAPaths.migrateLegacyData().
    this.dataDir = dataDir || vaultDir();
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {
      // Best-effort; save() will surface real failures.
    }
    this.vaultFile = path.join(this.dataDir, 'sera_api_vault.enc');
    this.keyFile = path.join(this.dataDir, 'sera_api_vault.key');
  }

  /** Loads (or creates) the machine-local encryption key. */
  private ensureEncryptionKey(): Buffer {
    if (this.encryptionKey) return this.encryptionKey;
    try {
      if (fs.existsSync(this.keyFile)) {
        const key = fs.readFileSync(this.keyFile);
        if (key.length === 32) {
          this.encryptionKey = key;
          return key;
        }
      }
      // Generate a fresh key.
      const key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, key, { mode: 0o600 });
      this.encryptionKey = key;
      return key;
    } catch (err) {
      throw new Error(`Could not initialize the API key vault: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private encrypt(plaintext: string): string {
    const key = this.ensureEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decrypt(payload: string): string {
    const key = this.ensureEncryptionKey();
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Vault payload malformed');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  private readVault(): Record<string, { cipher: string; updatedAt: number; lastTest?: VaultEntry['lastTest'] }> {
    try {
      if (!fs.existsSync(this.vaultFile)) return {};
      const raw = fs.readFileSync(this.vaultFile, 'utf8');
      return JSON.parse(raw) as Record<string, { cipher: string; updatedAt: number; lastTest?: VaultEntry['lastTest'] }>;
    } catch {
      return {};
    }
  }

  private writeVault(vault: Record<string, { cipher: string; updatedAt: number; lastTest?: VaultEntry['lastTest'] }>): void {
    const tmp = `${this.vaultFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.vaultFile);
  }

  private mask(key: string): string {
    if (key.length <= 8) return '••••';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  /** Saves (or replaces) a provider key. Returns the masked entry. */
  public setKey(provider: ApiProvider, key: string): VaultEntry {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key must not be empty.');
    const vault = this.readVault();
    const existing = vault[provider];
    vault[provider] = { cipher: this.encrypt(trimmed), updatedAt: Date.now(), lastTest: existing?.lastTest };
    this.writeVault(vault);
    return { provider, maskedKey: this.mask(trimmed), updatedAt: vault[provider].updatedAt, lastTest: existing?.lastTest };
  }

  /** Removes a provider key. */
  public deleteKey(provider: ApiProvider): boolean {
    const vault = this.readVault();
    if (!(provider in vault)) return false;
    delete vault[provider];
    this.writeVault(vault);
    return true;
  }

  /** Lists entries with masked keys (never returns plaintext). */
  public list(): VaultEntry[] {
    const vault = this.readVault();
    return API_PROVIDERS.filter((p) => vault[p.id]).map((p) => {
      const entry = vault[p.id];
      let maskedKey = '••••';
      try {
        maskedKey = this.mask(this.decrypt(entry.cipher));
      } catch {
        maskedKey = '(unreadable)';
      }
      return { provider: p.id, maskedKey, updatedAt: entry.updatedAt, lastTest: entry.lastTest };
    });
  }

  /** True when the given provider has a stored key. */
  public has(provider: ApiProvider): boolean {
    return provider in this.readVault();
  }

  /**
   * Resolves the effective API key for a provider: environment variable
   * first, then the encrypted vault. Returns null when unset.
   */
  public resolveKey(provider: ApiProvider): string | null {
    const meta = API_PROVIDERS.find((p) => p.id === provider);
    if (meta && process.env[meta.envVar]) return process.env[meta.envVar] as string;
    const vault = this.readVault();
    const entry = vault[provider];
    if (!entry) return null;
    try {
      return this.decrypt(entry.cipher);
    } catch {
      return null;
    }
  }

  /**
   * Instant connection test — calls the provider's lightweight models
   * endpoint with the given key (or the stored one) and reports honest
   * success/failure with latency.
   */
  public async testKey(provider: ApiProvider, providedKey?: string): Promise<KeyTestResult> {
    const meta = API_PROVIDERS.find((p) => p.id === provider);
    if (!meta) return { ok: false, message: `Unknown provider: ${provider}`, latencyMs: 0 };

    const key = providedKey?.trim() || this.resolveKey(provider);
    if (!key) return { ok: false, message: 'No API key configured for this provider.', latencyMs: 0 };

    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let response: Response;
      try {
        response = await fetch(meta.testUrl, { headers: meta.authHeader(key), signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        this.recordTestResult(provider, { ok: true, message: `Connection OK (HTTP ${response.status})`, testedAt: Date.now() });
        return { ok: true, message: `Connection successful — key is valid (HTTP ${response.status}, ${latencyMs}ms).`, latencyMs };
      }
      if (response.status === 401 || response.status === 403) {
        const message = `Key rejected by ${meta.label} (HTTP ${response.status}) — check the key value and permissions.`;
        this.recordTestResult(provider, { ok: false, message, testedAt: Date.now() });
        return { ok: false, message, latencyMs };
      }
      const body = await response.text().catch(() => '');
      const message = `${meta.label} responded HTTP ${response.status}: ${body.slice(0, 140)}`;
      this.recordTestResult(provider, { ok: false, message, testedAt: Date.now() });
      return { ok: false, message, latencyMs };
    } catch (err) {
      const message = `Network error while contacting ${meta.label}: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  private recordTestResult(provider: ApiProvider, result: { ok: boolean; message: string; testedAt: number }): void {
    try {
      const vault = this.readVault();
      const entry = vault[provider];
      if (entry) {
        entry.lastTest = { ok: result.ok, message: result.message, testedAt: result.testedAt };
        this.writeVault(vault);
      }
    } catch {
      // Test result persistence is best-effort.
    }
  }
}

/** Process-wide vault rooted next to the memory store. */
export const defaultApiKeyVault = new ApiKeyVault();
