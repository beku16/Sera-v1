import { featureDistance, extractVoiceFeatures } from './VoiceFeatureExtractor';
import { SpeakerConfidence, SpeakerMatch, SpeakerPermission, VoiceProfile } from './speakerTypes';

const STORAGE_KEY = 'sera_speaker_profiles_v1';
const HIGH_CONFIDENCE_DISTANCE = 0.16;
const MEDIUM_CONFIDENCE_DISTANCE = 0.32;

export class SpeakerManager {
  private profiles: VoiceProfile[] = [];
  private unknowns = new Map<string, number[]>();

  constructor(private readonly storage: Storage | null = typeof window !== 'undefined' ? window.localStorage : null) {
    this.load();
  }

  public listProfiles(): VoiceProfile[] { return this.profiles.map((profile) => ({ ...profile, voiceProfile: [] })); }

  public enroll(name: string, samples: Int16Array, options: { relationship?: string; permission?: SpeakerPermission; isPrimary?: boolean } = {}): VoiceProfile | null {
    const cleanName = name.trim();
    if (!cleanName || samples.length < 256) return null;
    const now = new Date().toISOString();
    const profile: VoiceProfile = {
      speakerId: `speaker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: cleanName,
      voiceProfile: extractVoiceFeatures(samples),
      createdAt: now,
      updatedAt: now,
      relationship: options.relationship,
      confidence: 'high',
      permission: options.isPrimary ? 'full_control' : options.permission ?? 'conversation',
      isPrimary: options.isPrimary ?? false,
    };
    if (profile.isPrimary) this.profiles = this.profiles.map((entry) => ({ ...entry, isPrimary: false, permission: entry.permission === 'full_control' ? 'conversation' : entry.permission }));
    this.profiles.push(profile);
    this.persist();
    return { ...profile, voiceProfile: [] };
  }

  public remove(speakerId: string): boolean {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((profile) => profile.speakerId !== speakerId);
    if (before !== this.profiles.length) this.persist();
    return before !== this.profiles.length;
  }

  public setPrimary(speakerId: string): boolean {
    const selected = this.profiles.some((profile) => profile.speakerId === speakerId);
    if (!selected) return false;
    this.profiles = this.profiles.map((profile) => ({ ...profile, isPrimary: profile.speakerId === speakerId, permission: profile.speakerId === speakerId ? 'full_control' : profile.permission === 'full_control' ? 'conversation' : profile.permission }));
    this.persist();
    return true;
  }

  public match(samples: Int16Array): SpeakerMatch {
    const features = extractVoiceFeatures(samples);
    let best: { profile: VoiceProfile; distance: number } | undefined;
    for (const profile of this.profiles) {
      const distance = featureDistance(features, profile.voiceProfile);
      if (!best || distance < best.distance) best = { profile, distance };
    }
    if (best && best.distance <= MEDIUM_CONFIDENCE_DISTANCE) {
      const confidence: SpeakerConfidence = best.distance <= HIGH_CONFIDENCE_DISTANCE ? 'high' : 'medium';
      return { speakerId: best.profile.speakerId, name: best.profile.name, confidence, score: Math.max(0, 1 - best.distance), known: true };
    }

    const unknownId = this.findUnknown(features);
    return { speakerId: unknownId, name: `Unknown Speaker${unknownId === 'unknown-1' ? '' : ` ${unknownId.split('-')[1]}`}`, confidence: 'low', score: best ? Math.max(0, 1 - best.distance) : 0, known: false };
  }

  public permissionFor(match: SpeakerMatch): SpeakerPermission {
    return this.profiles.find((profile) => profile.speakerId === match.speakerId)?.permission ?? 'conversation';
  }

  public clearSessionUnknowns(): void { this.unknowns.clear(); }

  private findUnknown(features: number[]): string {
    let nearest: { id: string; distance: number } | undefined;
    for (const [id, knownFeatures] of this.unknowns) {
      const distance = featureDistance(features, knownFeatures);
      if (!nearest || distance < nearest.distance) nearest = { id, distance };
    }
    if (nearest && nearest.distance < MEDIUM_CONFIDENCE_DISTANCE) return nearest.id;
    const id = `unknown-${this.unknowns.size + 1}`;
    this.unknowns.set(id, features);
    return id;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      this.profiles = Array.isArray(parsed) ? parsed.filter((profile) => Array.isArray(profile.voiceProfile)) : [];
    } catch { this.profiles = []; }
  }

  private persist(): void {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.profiles)); } catch { /* storage is optional */ }
  }
}

export const defaultSpeakerManager = new SpeakerManager();
