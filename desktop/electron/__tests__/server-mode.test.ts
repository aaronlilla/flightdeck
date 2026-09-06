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
  it('runs the built entry with the system node when it exists', () => {
    const fs: StartCommandFs = { existsSync: (p) => p === '/repo/dist/forge/cli.js' };
    const result = buildStartCommand(fs, join, '/repo', '/usr/bin/node');
    expect(result).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/dist/forge/cli.js', 'up'],
      cwd: '/repo',
    });
  });

  it('falls back to npm run forge -- up when there is no build', () => {
    const fs: StartCommandFs = { existsSync: () => false };
    const result = buildStartCommand(fs, join, '/repo', '/usr/bin/node');
    expect(result.args).toEqual(['run', 'forge', '--', 'up']);
    expect(result.cwd).toBe('/repo');
  });
});
