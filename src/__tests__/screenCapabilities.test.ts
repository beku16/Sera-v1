import { describe, expect, it } from 'vitest';
import { screenControlTool } from '../tools/tools/computerControlTools';

describe('screen capability routing', () => {
  it('requires screen capture permission to start sharing', () => {
    expect(screenControlTool.capabilityForArgs?.({ operation: 'startSharing' })).toBe('SCREEN_CAPTURE');
  });

  it('uses screen inspection permission for inspect and stop', () => {
    expect(screenControlTool.capabilityForArgs?.({ operation: 'inspect' })).toBe('SCREEN_INSPECTION');
    expect(screenControlTool.capabilityForArgs?.({ operation: 'stopSharing' })).toBe('SCREEN_INSPECTION');
  });
});
