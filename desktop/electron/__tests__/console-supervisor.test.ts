import { describe, it, expect, vi } from 'vitest';
import { bringUpConsole, type Spawned, type SupervisorDeps } from '../console-supervisor';

function fakeSpawned(): Spawned & { killed: boolean } {
  const obj = {
    pid: 123,
    killed: false,
    onExit: () => {},
    onOutput: () => {},
    kill: () => {
      obj.killed = true;
    },
  };
  return obj;
}

const join = (...parts: string[]) => parts.join('/');

describe('bringUpConsole', () => {
  it('attaches without spawning when something already answers', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', {
      probe: async () => ({ reachable: true }),
      spawn,
      fs: { existsSync: () => true },
      join,
      nodeExecPath: '/node',
      waitUntilReachable: async () => true,
      onLog: () => {},
    });
    expect(outcome).toEqual({ mode: 'attach' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns and reports started once the port answers', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn(() => child);
    const outcome = await bringUpConsole('/repo', {
      probe: async () => ({ reachable: false }),
      spawn,
      fs: { existsSync: () => true },
      join,
      nodeExecPath: '/node',
      waitUntilReachable: async () => true,
      onLog: () => {},
    });
    expect(outcome).toEqual({ mode: 'start', process: child });
    expect(spawn).toHaveBeenCalledWith('/node', ['/repo/dist/forge/cli.js', 'up'], '/repo', { ELECTRON_RUN_AS_NODE: '1' });
  });

  it('kills the spawned process and reports failure when it never comes up', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn(() => child);
    const deps: SupervisorDeps = {
      probe: async () => ({ reachable: false }),
      spawn,
      fs: { existsSync: () => true },
      join,
      nodeExecPath: '/node',
      waitUntilReachable: async () => false,
      onLog: () => {},
    };
    const outcome = await bringUpConsole('/repo', deps);
    expect(outcome.mode).toBe('start-failed');
    expect(child.killed).toBe(true);
  });
});
