/**
 * SERA — TaskClassifier.
 *
 * Pure, offline, zero-network classification of the user's request into a
 * task category + privacy level + hard capability requirements. Runs BEFORE
 * any model is chosen (spec: "SERA should classify the current task BEFORE
 * choosing a model"). Deliberately rule-based: it must work with the
 * internet fully down and must never leak user text anywhere.
 */
import type {
  CapabilityKey,
  PrivacyLevel,
  TaskCategory,
} from './types';

export interface TaskClassification {
  taskType: TaskCategory;
  privacy: PrivacyLevel;
  requires: CapabilityKey[];
  /** 1 (trivial) .. 10 (heavy multi-step reasoning). */
  complexity: number;
  /** Voice-style interactions need the lowest possible latency. */
  latencyCritical: boolean;
  /** Rough token estimate for context-fit routing (~4 chars/token). */
  estimatedTokens: number;
  reason: string;
}

interface CategoryRule {
  category: TaskCategory;
  pattern: RegExp;
  requires?: CapabilityKey[];
  complexity?: number;
}

/** Ordered rules — first strong match wins; weaker signals accumulate. */
const RULES: CategoryRule[] = [
  {
    category: 'wake_response',
    pattern: /^(hey|hi|hello|yo|ok|okay|thanks|thank you)[\s,.!]*(sera)?[\s,.!]*($|whats up|what'?s up|how are you|good)/i,
    complexity: 1,
  },
  {
    category: 'wake_response',
    pattern: /^(sera)[\s,.!]*$/i,
    complexity: 1,
  },
  {
    category: 'vision',
    pattern: /(look|looking) at (my|the) (screen|desktop|monitor)|screenshot|what('| i)?s? on my screen|read (my|the) screen|see (this|the screen)/i,
    requires: ['vision'],
    complexity: 4,
  },
  {
    category: 'screen_control',
    pattern: /click (the|on)? ?(button|link|icon)|which button|press (the )?(button|enter)|on my screen .*click|select (the )?(correct|right) (button|option)/i,
    requires: ['vision'],
    complexity: 5,
  },
  {
    category: 'browser_automation',
    pattern: /open (the )?(website|browser)|go to (https?:\/\/|www\.)|search (the )?web|google .* for me|browse to|youtube .*(open|find)/i,
    requires: ['tool_calling'],
    complexity: 3,
  },
  {
    category: 'debugging',
    pattern: /stack ?trace|this (error|exception|bug)|error says|doesn('| i)?t work|fails? with|debug (this|my)|traceback|error message/i,
    complexity: 6,
  },
  {
    category: 'coding',
    pattern: /write (a|the)? ?(function|class|script|component|query)|refactor|typescript|javascript|python code|regex|api endpoint|unit test|code (review|snippet)/i,
    complexity: 6,
  },
  {
    category: 'translation',
    pattern: /translate (this|it|that)? ?(to|into|from)?|in (spanish|french|german|hindi|japanese|chinese|arabic|portuguese|russian|korean|italian|tamil|telugu|bengali)/i,
    complexity: 2,
  },
  {
    category: 'summarization',
    pattern: /summari[sz]e|tl;?dr|shorten (this|it)|key (points|takeaways)|condense/i,
    complexity: 3,
  },
  {
    category: 'memory',
    pattern: /^remember( that)?|my name is|note that|keep in mind|i prefer|don'?t forget|recall (that|what)/i,
    complexity: 1,
  },
  {
    category: 'planning',
    pattern: /plan (a|my|the)|step[- ]by[- ]step (plan|guide)|schedule|organi[sz]e|roadmap|itinerary|strategy for/i,
    complexity: 7,
  },
  {
    category: 'extraction',
    pattern: /extract (all|the)|list (all|every)|find (all|every) (email|link|price|date)|parse (this|the)/i,
    complexity: 4,
  },
  {
    category: 'tool_execution',
    pattern: /^(open|close|launch|kill|click|type|paste|copy|set|mute|shutdown|minimize|maximize) \b/i,
    requires: ['tool_calling'],
    complexity: 2,
  },
  {
    category: 'complex_reasoning',
    pattern: /why (does|do|is|would)|explain (why|how|the)|compare|analy[sz]e|trade[- ]?offs?|pros and cons|what would happen|implications|reason through|think deeply/i,
    complexity: 7,
  },
];

const PRIVATE_PATTERNS: RegExp[] = [
  /password|passphrase|secret|api[-_ ]?key|auth[-_ ]?token|bearer|credential/i,
  /credit card|debit card|cvv|ssn|social security|bank (account|statement)|salary|invoice.*\$?\d/i,
  /my (private )?(diary|photos|documents|files|personal)|medical (record|report|result)|diagnos[ei]s|prescription/i,
];

const PUBLIC_PATTERNS: RegExp[] = [
  /who (is|was|won)|capital of|population of|weather|news|definition of|wikipedia|what year did/i,
];

/** Very short voice-style utterances — route to a fast brain. */
function looksLikeVoiceUtterance(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && !trimmed.includes('\n');
}

export class TaskClassifier {
  /** Classify a user request. Never throws, never touches the network. */
  classify(text: string, hints?: { hasImages?: boolean; requires?: CapabilityKey[] }): TaskClassification {
    const safeText = typeof text === 'string' ? text : '';
    const estimatedTokens = Math.ceil(safeText.length / 4) + 32;
    const requires = new Set<CapabilityKey>(hints?.requires ?? []);
    let taskType: TaskCategory = 'conversation';
    let complexity = 2;
    let reason = 'default conversational routing';

    for (const rule of RULES) {
      if (rule.pattern.test(safeText)) {
        taskType = rule.category;
        complexity = rule.complexity ?? 3;
        reason = `matched ${rule.category} pattern`;
        if (rule.requires) rule.requires.forEach((c) => requires.add(c));
        break;
      }
    }

    // Long inputs need long context regardless of category.
    if (safeText.length > 6000) {
      requires.add('long_context');
      complexity = Math.max(complexity, 6);
      if (taskType === 'conversation') taskType = 'long_context';
      reason += ' + large input';
    }

    if (hints?.hasImages) {
      requires.add('vision');
      taskType = 'multimodal';
      complexity = Math.max(complexity, 5);
      reason = 'request carries images';
    }

    // Privacy classification (spec: PRIVACY-AWARE ROUTING).
    let privacy: PrivacyLevel = 'normal';
    if (PRIVATE_PATTERNS.some((p) => p.test(safeText))) {
      privacy = /password|api[-_ ]?key|secret|credential|credit card|ssn|bank/i.test(safeText)
        ? 'highly_private'
        : 'private';
      reason += ` + privacy=${privacy}`;
    } else if (PUBLIC_PATTERNS.some((p) => p.test(safeText))) {
      privacy = 'public';
    }

    // Memory/private/local tasks are natural local fits.
    if (taskType === 'memory' && privacy === 'normal') privacy = 'private';

    const latencyCritical = looksLikeVoiceUtterance(safeText) || taskType === 'wake_response' || taskType === 'voice';
    if (taskType === 'wake_response') taskType = 'wake_response';

    // Very short non-greeting text is simple Q&A or a quick command.
    if (taskType === 'conversation' && safeText.trim().endsWith('?') && safeText.length < 120) {
      taskType = 'simple_qa';
      complexity = 2;
      reason = 'short factual question';
    }

    return {
      taskType,
      privacy,
      requires: [...requires],
      complexity,
      latencyCritical,
      estimatedTokens,
      reason,
    };
  }

  /**
   * Classify a PLANNING subtask (AGI PlanStep descriptions) so multi-model
   * execution can route each subtask to a suitable brain.
   */
  classifySubtask(description: string): TaskClassification {
    return this.classify(description);
  }

  /** Map a task category to the capability weights the router should favor. */
  static taskCapabilityWeights(taskType: TaskCategory): Partial<Record<CapabilityKey, number>> {
    switch (taskType) {
      case 'wake_response':
      case 'voice':
        return { fast_response: 3, reasoning: 0.2, coding: 0 };
      case 'simple_qa':
      case 'conversation':
        return { fast_response: 1.5, reasoning: 1 };
      case 'complex_reasoning':
        return { reasoning: 3, long_context: 0.5 };
      case 'coding':
      case 'debugging':
        return { coding: 3, reasoning: 1.5 };
      case 'vision':
      case 'screen_control':
      case 'multimodal':
        return { vision: 4, reasoning: 1 };
      case 'browser_automation':
      case 'tool_execution':
        return { tool_calling: 3, fast_response: 1 };
      case 'planning':
        return { reasoning: 2.5, long_context: 1 };
      case 'summarization':
        return { summarization: 2.5, long_context: 1.5 };
      case 'translation':
        return { translation: 3, fast_response: 0.5 };
      case 'memory':
      case 'local_private_task':
        return { reasoning: 1, fast_response: 1 };
      case 'long_context':
        return { long_context: 4, reasoning: 1 };
      case 'classification':
      case 'extraction':
        return { reasoning: 1.5, fast_response: 1.5 };
      default:
        return { reasoning: 1, fast_response: 0.5 };
    }
  }
}
