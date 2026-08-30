import { GoalPlan, PlanStep, VerificationExpectation } from './planTypes';

/**
 * Declarative pattern rules used by the heuristic planner. Each rule
 * matches a goal phrase pattern and emits a reusable step chain. These
 * encode the canonical SERA chains documented in the system instruction
 * (open → type → verify, search → read → summarize, etc.).
 */
interface PlannerRule {
  id: string;
  test: RegExp;
  strategy: string;
  build: (match: RegExpMatchArray, normalized: string) => PlanStep[];
}

const stepIdCounter = (() => {
  let counter = 0;
  return () => `s${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
})();

const rule = (
  id: string,
  test: RegExp,
  strategy: string,
  build: (match: RegExpMatchArray, normalized: string) => PlanStep[],
): PlannerRule => ({ id, test, strategy, build });

/**
 * Ordered rule set — most specific first.
 */
const RULES: PlannerRule[] = [
  rule(
    'open-app-and-type',
    /(?:open|launch|start)\s+(?:the\s+)?([\w .+-]+?)(?:\s+(?:app|application))?\s+(?:and|then|,)\s*(?:type|enter|write|put)\s+["“']?(.+?)["”']?(?:\s+(?:in|into|in to)\s+(?:it|the app))?$/i,
    'Launch the application, wait for its window, type the content, then verify by reading the screen.',
    (match) => {
      const app = match[1].trim();
      const text = match[2].trim();
      const openId = stepIdCounter();
      const typeId = stepIdCounter();
      const verifyId = stepIdCounter();
      return [
        {
          id: openId,
          description: `Launch ${app}`,
          tool: 'openApplication',
          args: { application: app },
          dependsOn: [],
          verification: { kind: 'window_visible', value: app, description: `${app} window is visible` },
        },
        {
          id: typeId,
          description: `Type "${text}" into ${app}`,
          tool: 'controlComputerInput',
          args: { operation: 'type', text },
          dependsOn: [openId],
          parallelizable: false,
        },
        {
          id: verifyId,
          description: `Verify ${app} shows the expected content`,
          tool: 'inspectScreen',
          args: {},
          dependsOn: [typeId],
          verification: { kind: 'text_contains', value: text.replace(/\s+/g, ''), description: 'screen text reflects the typed content' },
        },
      ];
    },
  ),
  rule(
    'open-website',
    /(?:open|visit|go to|navigate to)\s+((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)/i,
    'Open the requested URL directly in the user’s browser.',
    (match) => {
      const url = match[1].startsWith('http') ? match[1] : `https://${match[1]}`;
      return [
        {
          id: stepIdCounter(),
          description: `Open ${url} in the browser`,
          tool: 'openWebsite',
          args: { url },
          dependsOn: [],
          verification: { kind: 'tool_success', description: 'website opened successfully' },
        },
      ];
    },
  ),
  rule(
    'search-web',
    /(?:search(?: the (?:web|internet))? for|look up|find (?:info(?:rmation)? )?(?:about|on))\s+(.+)/i,
    'Run a web search, then open the top result for reading.',
    (match) => {
      const query = match[1].trim();
      const searchId = stepIdCounter();
      return [
        {
          id: searchId,
          description: `Search the web for "${query}"`,
          tool: 'searchWeb',
          args: { query },
          dependsOn: [],
          verification: { kind: 'tool_success', description: 'search returned results' },
        },
      ];
    },
  ),
  rule(
    'focus-and-close-window',
    /(?:close|shut (?:down|off))\s+(?:the\s+)?([\w .+-]+?)(?:\s+(?:app|application|window))?$/i,
    'Gracefully close the matching window.',
    (match) => [
      {
        id: stepIdCounter(),
        description: `Close ${match[1].trim()}`,
        tool: 'closeWindow',
        args: { application: match[1].trim() },
        dependsOn: [],
        verification: { kind: 'tool_success', description: 'window closed' },
      },
    ],
  ),
  rule(
    'screenshot',
    /(?:take|capture|grab)\s+(?:a\s+)?(?:screenshot|screen ?shot|snapshot)(?:\s+of\s+(.+))?/i,
    'Capture a screenshot and return it for inspection.',
    (match) => [
      {
        id: stepIdCounter(),
        description: match[1] ? `Capture a screenshot of ${match[1].trim()}` : 'Capture a full-screen screenshot',
        tool: match[1] ? 'captureWindowScreenshot' : 'captureScreenshot',
        args: match[1] ? { application: match[1].trim() } : {},
        dependsOn: [],
        verification: { kind: 'tool_success', description: 'screenshot captured' },
      },
    ],
  ),
  rule(
    'set-clipboard',
    /(?:copy|put)\s+["“']?(.+?)["”']?\s+(?:to|on|into)\s+(?:the\s+)?clipboard/i,
    'Write the requested text to the system clipboard and verify by reading it back.',
    (match) => {
      const text = match[1].trim();
      const setId = stepIdCounter();
      return [
        {
          id: setId,
          description: `Copy "${text}" to the clipboard`,
          tool: 'setClipboard',
          args: { content: text },
          dependsOn: [],
          verification: { kind: 'clipboard_equals', value: text, description: 'clipboard round-trip matches' },
        },
      ];
    },
  ),
  rule(
    'whatsapp',
    /(?:send|text)\s+(?:a\s+)?(?:message\s+)?(?:to\s+)?([\w .-]+?)\s+(?:on\s+whatsapp|via whatsapp|whatsapp)\s*(?:saying|that says|:)?\s*["“']?(.*?)["”']?$/i,
    'Open WhatsApp Web, find the contact, deliver the message.',
    (match) => [
      {
        id: stepIdCounter(),
        description: `Send WhatsApp message to ${match[1].trim()}`,
        tool: 'sendWhatsAppMessage',
        args: { contact: match[1].trim(), ...(match[2] ? { message: match[2].trim() } : {}) },
        dependsOn: [],
        verification: { kind: 'tool_success', description: 'message verified in chat' },
      },
    ],
  ),
];

/**
 * The Hierarchical Goal Decomposition planner.
 *
 * Given a broad voice instruction ("open calculator and type 25*25"),
 * produces a DAG of executable sub-tasks with dependencies and
 * verification expectations. Pure-function by design so it can be unit
 * tested without any LLM available — the optional LLM pass (online
 * Gemini or local Ollama) can refine plans later, but SERA remains fully
 * functional offline via these pattern rules.
 */
export class GoalPlanner {
  /**
   * Decomposes a goal into a DAG. When `llmPlanner` is provided and
   * returns a valid plan, it is used; otherwise the heuristic rules run.
   */
  public async decompose(
    goal: string,
    context?: { llmPlanner?: (goal: string) => Promise<PlanStep[] | null> },
  ): Promise<GoalPlan> {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      return { goal: '', strategySummary: 'Empty goal — nothing to plan.', steps: [], plannedAt: Date.now(), origin: 'heuristic' };
    }

    if (context?.llmPlanner) {
      try {
        const llmSteps = await context.llmPlanner(trimmedGoal);
        if (llmSteps && llmSteps.length > 0 && this.validateDag(llmSteps)) {
          return {
            goal: trimmedGoal,
            strategySummary: 'LLM-decomposed hierarchical plan.',
            steps: llmSteps,
            plannedAt: Date.now(),
            origin: 'llm',
          };
        }
      } catch {
        // Fall through to heuristic planning.
      }
    }

    for (const plannerRule of RULES) {
      const match = trimmedGoal.match(plannerRule.test);
      if (match) {
        return {
          goal: trimmedGoal,
          strategySummary: plannerRule.strategy,
          steps: plannerRule.build(match, trimmedGoal),
          plannedAt: Date.now(),
          origin: 'heuristic',
        };
      }
    }

    // Generic fallback: perceive, attempt direct tool-free answer surface.
    return {
      goal: trimmedGoal,
      strategySummary: 'No specialized chain matched — falling back to conversational reasoning in the live session.',
      steps: [],
      plannedAt: Date.now(),
      origin: 'heuristic',
    };
  }

  /**
   * Validates that a step set is a well-formed DAG: unique ids, no
   * self-dependency, no dangling references, no cycles (via Kahn's
   * algorithm), and at least one root.
   */
  public validateDag(steps: PlanStep[]): boolean {
    const ids = new Set(steps.map((s) => s.id));
    if (ids.size !== steps.length) return false;

    let edgeCount = 0;
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const step of steps) {
      inDegree.set(step.id, step.dependsOn.length);
      for (const dep of step.dependsOn) {
        if (!ids.has(dep) || dep === step.id) return false;
        edgeCount += 1;
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(step.id);
      }
    }
    if (steps.length > 0 && edgeCount === 0) return true; // all roots — valid parallel set

    let visited = 0;
    const queue: string[] = steps.filter((s) => (inDegree.get(s.id) || 0) === 0).map((s) => s.id);
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited += 1;
      for (const next of adjacency.get(node) || []) {
        const degree = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, degree);
        if (degree === 0) queue.push(next);
      }
    }
    return visited === steps.length;
  }

  /** Rule introspection (diagnostics / tests). */
  public get ruleCount(): number {
    return RULES.length;
  }
}

/** Verification helper re-exported for the ExecutionGraph. */
export function describeVerification(expectation: VerificationExpectation): string {
  return expectation.description || `${expectation.kind}${expectation.value ? `:${expectation.value}` : ''}`;
}
