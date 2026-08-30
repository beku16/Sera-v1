export type LatencyStage =
  | 'microphone.chunk'
  | 'client.audio.received'
  | 'gemini.audio.accepted'
  | 'gemini.response'
  | 'tool.call'
  | 'turn.complete';

export interface LatencyMark {
  stage: LatencyStage;
  at: number;
  deltaFromPreviousMs?: number;
}

export class LatencyTrace {
  private readonly marks: LatencyMark[] = [];
  private previousAt: number | null = null;

  public mark(stage: LatencyStage, at = Date.now()): LatencyMark {
    const mark: LatencyMark = {
      stage,
      at,
      ...(this.previousAt === null ? {} : { deltaFromPreviousMs: Math.max(0, at - this.previousAt) }),
    };
    this.previousAt = at;
    this.marks.push(mark);
    if (this.marks.length > 100) this.marks.shift();
    return mark;
  }

  public snapshot(): LatencyMark[] {
    return this.marks.map((mark) => ({ ...mark }));
  }
}
