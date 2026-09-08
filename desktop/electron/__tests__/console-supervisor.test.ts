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
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
      join,
      nodeExecPath: '/node',
      homeDir: '/h',
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
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
      join,
      nodeExecPath: '/node',
      homeDir: '/h',
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
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
      join,
      nodeExecPath: '/node',
      homeDir: '/h',
      waitUntilReachable: async () => false,
      onLog: () => {},
    };
    const outcome = await bringUpConsole('/repo', deps);
    expect(outcome.mode).toBe('start-failed');
    expect(child.killed).toBe(true);
  });

  it('starts through the launcher when console.launch.cmd exists, and reports attach once it answers', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn((_command: string, _args: string[], _cwd: string, _env: Record<string, string>) => child);
    const logs: string[] = [];
    const outcome = await bringUpConsole('/repo', {
      probe: async () => ({ reachable: false }),
      spawn,
      fs: { existsSync: (p) => p === '/h/.forge/console.launch.cmd' },
      join,
      nodeExecPath: '/node',
      homeDir: '/h',
      waitUntilReachable: async () => true,
      onLog: (line) => logs.push(line),
    });
    expect(outcome).toEqual({ mode: 'attach' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, , , env] = spawn.mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? 'powershell' : '/h/.forge/console.launch.cmd');
    expect(env).toEqual({});
    expect(logs.some((line) => line.includes('/h/.forge/console.launch.cmd'))).toBe(true);
    expect(logs.some((line) => line.includes('not this app'))).toBe(true);
  });
});
