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

function baseDeps(overrides: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    probe: async () => ({ reachable: false }),
    probeHealth: async () => ({ health: 'down' }),
    queueLockOwner: () => undefined,
    spawn: vi.fn(),
    fs: { existsSync: () => false },
    join,
    nodeExecPath: '/node',
    homeDir: '/h',
    waitUntilReachable: async () => true,
    onLog: () => {},
    runBuild: async () => ({ ok: true, output: '' }),
    ...overrides,
  };
}

describe('bringUpConsole', () => {
  it('attaches without spawning when health reads up-healthy', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', baseDeps({
      probeHealth: async () => ({ health: 'up-healthy' }),
      spawn,
      runBuild: async () => { throw new Error('must not build when attaching'); },
    }));
    expect(outcome).toEqual({ mode: 'attach' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns and reports started once the port answers', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn(() => child);
    const outcome = await bringUpConsole('/repo', baseDeps({
      probeHealth: async () => ({ health: 'down' }),
      spawn,
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
    }));
    expect(outcome).toEqual({ mode: 'start', process: child });
    expect(spawn).toHaveBeenCalledWith('/node', ['/repo/dist/forge/cli.js', 'up'], '/repo', { ELECTRON_RUN_AS_NODE: '1' });
  });

  it('reports start-failed and never spawns when the build step fails', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', baseDeps({
      spawn,
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
      runBuild: async () => ({ ok: false, output: 'vite build failed: config error' }),
    }));
    expect(outcome.mode).toBe('start-failed');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills the spawned process and reports failure when it never comes up', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn(() => child);
    const outcome = await bringUpConsole('/repo', baseDeps({
      spawn,
      fs: { existsSync: (p) => p === '/repo/dist/forge/cli.js' },
      waitUntilReachable: async () => false,
    }));
    expect(outcome.mode).toBe('start-failed');
    expect(child.killed).toBe(true);
  });

  it('starts through the launcher when console.launch.cmd exists, and reports attach once it answers', async () => {
    const child = fakeSpawned();
    const spawn = vi.fn((_command: string, _args: string[], _cwd: string, _env: Record<string, string>) => child);
    const logs: string[] = [];
    const outcome = await bringUpConsole('/repo', baseDeps({
      spawn,
      fs: { existsSync: (p) => p === '/h/.forge/console.launch.cmd' },
      onLog: (line) => logs.push(line),
      runBuild: async () => { throw new Error('must not build for a launcher-managed plan'); },
    }));
    expect(outcome).toEqual({ mode: 'attach' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, , , env] = spawn.mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? 'powershell' : '/h/.forge/console.launch.cmd');
    expect(env).toEqual({});
    expect(logs.some((line) => line.includes('/h/.forge/console.launch.cmd'))).toBe(true);
    expect(logs.some((line) => line.includes('not this app'))).toBe(true);
  });

  // Item 3, 2026-09-10 (critique finding, was unwired): decideConsoleAction is now
  // actually consulted here, not just proven in isolation.
  it('an alive queue-lock owner yields wait and never spawns, whatever health reads', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', baseDeps({
      probeHealth: async () => ({ health: 'down' }),
      queueLockOwner: () => ({ pid: 9999, alive: true }),
      spawn,
      runBuild: async () => { throw new Error('must not build while waiting'); },
    }));
    expect(outcome).toEqual({ mode: 'wait', ownerPid: 9999 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('up-no-console with no lock owner reports show-no-console rather than attaching', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', baseDeps({
      probeHealth: async () => ({ health: 'up-no-console' }),
      spawn,
      runBuild: async () => { throw new Error('must not build for show-no-console') },
    }));
    expect(outcome).toEqual({ mode: 'show-no-console' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('up-foreign with no lock owner reports confirm-restart rather than attaching or spawning', async () => {
    const spawn = vi.fn();
    const outcome = await bringUpConsole('/repo', baseDeps({
      probeHealth: async () => ({ health: 'up-foreign' }),
      spawn,
      runBuild: async () => { throw new Error('must not build for confirm-restart') },
    }));
    expect(outcome).toEqual({ mode: 'confirm-restart' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
