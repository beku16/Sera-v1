import { SpeakerMatch, SessionSpeakerState } from './speakerTypes';

const ADDRESS_PATTERN = /^(?:hey\s+)?sera\b[\s,:-]*/i;
const COMMAND_PATTERN = /\b(open|close|start|stop|search|click|type|press|cancel|pause|resume|remember|forget)\b/i;

export class ConversationRouter {
  private state: SessionSpeakerState = { currentSpeaker: null, activeConversationSpeaker: null, knownSpeakers: [], unknownSpeakers: [], speakerConfidence: null, addressedToSera: false };

  public observe(speaker: SpeakerMatch, text?: string, overlapping = false): SessionSpeakerState {
    const addressed = !overlapping && !!text && (ADDRESS_PATTERN.test(text) || (this.state.activeConversationSpeaker?.speakerId === speaker.speakerId && COMMAND_PATTERN.test(text)));
    this.state = {
      ...this.state,
      currentSpeaker: speaker,
      activeConversationSpeaker: addressed ? speaker : this.state.activeConversationSpeaker,
      speakerConfidence: speaker.confidence,
      addressedToSera: addressed,
      knownSpeakers: speaker.known && !this.state.knownSpeakers.some((entry) => entry.speakerId === speaker.speakerId) ? [...this.state.knownSpeakers, speaker] : this.state.knownSpeakers,
      unknownSpeakers: !speaker.known && !this.state.unknownSpeakers.some((entry) => entry.speakerId === speaker.speakerId) ? [...this.state.unknownSpeakers, speaker] : this.state.unknownSpeakers,
    };
    return this.getState();
  }

  public shouldRespond(text: string, speaker: SpeakerMatch, overlapping = false): boolean {
    return !overlapping && (ADDRESS_PATTERN.test(text) || this.state.activeConversationSpeaker?.speakerId === speaker.speakerId);
  }

  public getState(): SessionSpeakerState { return { ...this.state, knownSpeakers: [...this.state.knownSpeakers], unknownSpeakers: [...this.state.unknownSpeakers] }; }
  public reset(): void { this.state = { currentSpeaker: null, activeConversationSpeaker: null, knownSpeakers: [], unknownSpeakers: [], speakerConfidence: null, addressedToSera: false }; }
}
