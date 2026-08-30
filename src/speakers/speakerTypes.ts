export type SpeakerConfidence = 'high' | 'medium' | 'low';
export type SpeakerPermission = 'full_control' | 'conversation' | 'restricted';

export interface VoiceProfile {
  speakerId: string;
  name: string;
  voiceProfile: number[];
  createdAt: string;
  updatedAt: string;
  relationship?: string;
  memoryId?: string;
  confidence: SpeakerConfidence;
  permission: SpeakerPermission;
  isPrimary: boolean;
}

export interface SpeakerMatch {
  speakerId: string;
  name: string;
  confidence: SpeakerConfidence;
  score: number;
  known: boolean;
}

export interface SpeakerObservation {
  speaker: SpeakerMatch;
  isSpeech: boolean;
  started: boolean;
  ended: boolean;
  timestamp: number;
}

export interface SessionSpeakerState {
  currentSpeaker: SpeakerMatch | null;
  activeConversationSpeaker: SpeakerMatch | null;
  knownSpeakers: SpeakerMatch[];
  unknownSpeakers: SpeakerMatch[];
  speakerConfidence: SpeakerConfidence | null;
  addressedToSera: boolean;
}
