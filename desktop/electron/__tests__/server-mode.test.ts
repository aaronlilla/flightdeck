import { describe, it, expect } from 'vitest';
import { decideServerMode, buildStartCommand, type StartCommandFs } from '../server-mode';

const join = (...parts: string[]) => parts.join('/');

describe('decideServerMode', () => {
  it('attaches when something already answers', () => {
    expect(decideServerMode(true)).toBe('attach');
  });

  it('starts when nothing answers', () => {
    expect(decideServerMode(false)).toBe('start');
  });
});

describe('buildStartCommand', () => {
  // Packaged, the executable handed in here is this application itself, not a Node
  // binary: launching a script with it starts a second copy of the desktop app and no
  // console at all, which is exactly what happened the first time the start path ran
  // for real. `ELECTRON_RUN_AS_NODE` is what makes that executable run the script.
  it('runs the built entry with the executable put into node mode', () => {
    const fs: StartCommandFs = { existsSync: (p) => p === '/repo/dist/forge/cli.js' };
    const result = buildStartCommand(fs, join, '/repo', '/apps/Console.exe');
    expect(result).toEqual({
      command: '/apps/Console.exe',
      args: ['/repo/dist/forge/cli.js', 'up'],
      cwd: '/repo',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('falls back to npm run forge -- up when there is no build', () => {
    const fs: StartCommandFs = { existsSync: () => false };
    const result = buildStartCommand(fs, join, '/repo', '/usr/bin/node');
    expect(result.args).toEqual(['run', 'forge', '--', 'up']);
    expect(result.cwd).toBe('/repo');
  });
});
