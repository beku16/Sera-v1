import { describe, expect, it } from 'vitest';
import { openApplicationTool } from '../tools/tools/openApplication';

describe('openApplication capability routing', () => {
  it('requires browser control for website targets', () => {
    expect(openApplicationTool.capabilityForArgs?.({ application: 'https://example.com' })).toBe('BROWSER_CONTROL');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'youtube' })).toBe('BROWSER_CONTROL');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'gmail.com' })).toBe('BROWSER_CONTROL');
  });

  it('requires application launch for desktop targets', () => {
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Notepad' })).toBe('APPLICATION_LAUNCH');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Calculator' })).toBe('APPLICATION_LAUNCH');
  });

  it('routes desktop-first brands to APPLICATION_LAUNCH even when they are also known websites', () => {
    // Discord, Spotify, Slack, Telegram all have KNOWN_SITES_MAP entries
    // but the user almost always means the desktop app. Without this
    // routing, "open Discord" opened discord.com in a headless browser
    // the user couldn't see — instead of launching the installed app.
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Discord' })).toBe('APPLICATION_LAUNCH');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Spotify' })).toBe('APPLICATION_LAUNCH');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'slack' })).toBe('APPLICATION_LAUNCH');
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Telegram' })).toBe('APPLICATION_LAUNCH');
  });

  it('respects explicit intent overrides', () => {
    // Force web for a desktop-first brand
    expect(openApplicationTool.capabilityForArgs?.({ application: 'Discord', intent: 'web' })).toBe('BROWSER_CONTROL');
    // Force desktop for a website name
    expect(openApplicationTool.capabilityForArgs?.({ application: 'youtube', intent: 'desktop' })).toBe('APPLICATION_LAUNCH');
  });
});
