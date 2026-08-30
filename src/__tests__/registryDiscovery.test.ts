import { describe, expect, it } from 'vitest';
import { parseRegistryApplications } from '../authorization/RegistryApplicationDiscovery';

describe('registry application discovery', () => {
  it('parses executable DisplayIcon values and removes icon indexes', () => {
    const output = JSON.stringify([
      { DisplayName: 'Example App', DisplayIcon: '"C:\\Program Files\\Example\\example.exe",0' },
      { DisplayName: 'Another App', DisplayIcon: 'C:\\Apps\\another.exe,1' },
    ]);

    expect(parseRegistryApplications(output)).toEqual([
      { name: 'Example App', executable: 'C:\\Program Files\\Example\\example.exe' },
      { name: 'Another App', executable: 'C:\\Apps\\another.exe' },
    ]);
  });

  it('ignores entries without a concrete executable path', () => {
    expect(parseRegistryApplications(JSON.stringify([
      { DisplayName: 'Folder Only', InstallLocation: 'C:\\Apps\\Folder' },
      { DisplayName: 'Malformed', DisplayIcon: 'not-an-executable' },
    ]))).toEqual([]);
  });

  it('handles PowerShell single-object JSON and invalid output', () => {
    expect(parseRegistryApplications(JSON.stringify({ DisplayName: 'Solo', DisplayIcon: 'C:\\Solo\\solo.exe' }))).toEqual([
      { name: 'Solo', executable: 'C:\\Solo\\solo.exe' },
    ]);
    expect(parseRegistryApplications('invalid')).toEqual([]);
  });
});
