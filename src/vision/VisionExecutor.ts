import { ScreenUnderstanding } from './ScreenUnderstanding';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from '../actions/types';
import { ActionError, ACTION_ERROR_CODES } from '../actions/errors';

export class VisionExecutor implements ActionExecutor {
  public readonly name = 'VisionExecutor';

  constructor(private readonly understanding: ScreenUnderstanding) {}

  public canHandle(action: Action): boolean {
    return action.type === 'vision.inspect' || action.type === 'vision.locate';
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    if (action.type === 'vision.inspect') {
      const rawRegion = action.parameters?.region;
      const region = rawRegion && typeof rawRegion === 'object' ? rawRegion as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } : undefined;
      const validRegion = region && [region.x, region.y, region.width, region.height].every((value) => typeof value === 'number' && Number.isInteger(value));
      if (rawRegion && !validRegion) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'Screen region requires integer x, y, width, and height.');
      return { result: await this.understanding.inspectScreen(validRegion ? region as { x: number; y: number; width: number; height: number } : undefined) };
    }
    if (action.type === 'vision.locate') {
      const query = action.parameters && typeof action.parameters.query === 'string' ? action.parameters.query : '';
      if (!query.trim()) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'An element description is required.');
      const minimumConfidence = typeof action.parameters.minimumConfidence === 'number' ? action.parameters.minimumConfidence : undefined;
      return { result: await this.understanding.locateElement(query, minimumConfidence) };
    }
    throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Vision action "${action.type}" is not supported.`);
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    if (action.type === 'vision.inspect') {
      const observation = execution.result as { text?: unknown; elements?: unknown } | undefined;
      return observation && typeof observation.text === 'string' && Array.isArray(observation.elements)
        ? { status: 'success', message: 'Screen observation created.' }
        : { status: 'failure', message: 'Screen understanding returned an invalid observation.' };
    }
    return execution.result
      ? { status: 'success', message: 'A matching visible element was located.' }
      : { status: 'inconclusive', message: 'No matching visible element was found.' };
  }
}
