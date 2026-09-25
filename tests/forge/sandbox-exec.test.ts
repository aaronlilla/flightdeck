/**
 * The containment boundary around a verification command.
 *
 * These specimens assert the properties that make the boundary worth anything: the
 * worktree is the only host path reachable, the network is off unless asked for, the
 * command does not run as root, the container cannot gain privileges, and it is removed
 * on exit. A Windows host path has to be rewritten or the bind mount silently becomes an
 * empty named volume -- a command that then passes proves nothing, which is the exact
 * failure this module exists to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SANDBOX_IMAGE, describeSandbox, mountPathFor, readSandboxConfig, sandboxCommand,
  containerNameFor, sandboxReapCommand, sandboxSweepCommand, SANDBOX_CONTAINER_PREFIX,
} from '../../src/forge/sandbox-exec.js';

describe('readSandboxConfig', () => {
  it('is ON by default, because a boundary nobody enables is not a boundary', () => {
    expect(readSandboxConfig({}).enabled).toBe(true);
    expect(readSandboxConfig({ FORGE_SANDBOX: '1' }).enabled).toBe(true);
    expect(readSandboxConfig({ FORGE_SANDBOX: '0' }).enabled).toBe(false);
  });

  it('distinguishes a deliberate opt-out from a default, so a missing runtime can refuse', () => {
    expect(readSandboxConfig({}).optedOut).toBe(false);
    expect(readSandboxConfig({ FORGE_SANDBOX: '0' }).optedOut).toBe(true);
  });

  it('defaults to no network, a non-root user and the pinned image', () => {
    const config = readSandboxConfig({ FORGE_SANDBOX: '1' });
    expect(config.network).toBe('none');
    expect(config.user).toBe('1000:1000');
    expect(config.image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(config.runtime).toBe('docker');
  });

  it('only accepts bridge as an opt-in; any other value stays closed', () => {
    expect(readSandboxConfig({ FORGE_SANDBOX: '1', FORGE_SANDBOX_NETWORK: 'bridge' }).network)
      .toBe('bridge');
    expect(readSandboxConfig({ FORGE_SANDBOX: '1', FORGE_SANDBOX_NETWORK: 'host' }).network)
      .toBe('none');
    expect(readSandboxConfig({ FORGE_SANDBOX: '1', FORGE_SANDBOX_NETWORK: '' }).network)
      .toBe('none');
  });
});

describe('mountPathFor', () => {
  it('rewrites a Windows path, or the bind mount becomes an empty named volume', () => {
    expect(mountPathFor('C:\\dev\\worktrees\\fd-sandbox--luck-5'))
      .toBe('/c/dev/worktrees/fd-sandbox--luck-5');
    expect(mountPathFor('C:/dev/fd-sandbox')).toBe('/c/dev/fd-sandbox');
  });

  it('leaves a POSIX path alone', () => {
    expect(mountPathFor('/home/aaron/worktrees/x')).toBe('/home/aaron/worktrees/x');
  });
});

describe('sandboxCommand', () => {
  const config = readSandboxConfig({ FORGE_SANDBOX: '1' });

  it('mounts the worktree and nothing else', () => {
    const { argv } = sandboxCommand(config, { command: 'npm test', cwd: 'C:/dev/worktrees/x--t1' });
    const mounts = argv.filter((_, i) => argv[i - 1] === '-v');
    expect(mounts).toEqual(['/c/dev/worktrees/x--t1:/work']);
  });

  it('runs with the network off, unprivileged, and removes the container on exit', () => {
    const { argv } = sandboxCommand(config, { command: 'npm test', cwd: '/w' });
    expect(argv).toContain('--rm');
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
    expect(argv[argv.indexOf('--user') + 1]).toBe('1000:1000');
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('caps pids, memory and cpu, because time is not a resource limit', () => {
    // Without these a fork bomb or runaway allocation inside the boundary takes the
    // host down, and the 900s wall budget would not notice for fifteen minutes.
    const { argv } = sandboxCommand(config, { command: 'npm test', cwd: '/w' });
    expect(argv[argv.indexOf('--pids-limit') + 1]).toBe('512');
    expect(argv[argv.indexOf('--memory') + 1]).toBe('4g');
    expect(argv[argv.indexOf('--memory-swap') + 1]).toBe('4g');
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('2');
  });

  it('sweeps by prefix, for a parent killed before its finally could run', () => {
    expect(sandboxSweepCommand(config)).toEqual([
      'docker', 'rm', '-f', '$(docker ps -aq --filter name=^forge-)',
    ]);
    expect(SANDBOX_CONTAINER_PREFIX).toBe('forge-');
  });

  it('keeps a chained command intact as one shell string', () => {
    const command = 'npm ci && npm test && npm run lint';
    const { argv } = sandboxCommand(config, { command, cwd: '/w' });
    expect(argv.slice(-3)).toEqual(['sh', '-lc', command]);
  });

  it('names the container so a budget kill can reap it', () => {
    // The container is the daemon's child, not the runtime CLI's, so killing the CLI
    // process tree leaves it running past its wall/idle budget. A name is what makes
    // the workload reachable afterwards.
    const { argv, containerName } = sandboxCommand(config, {
      command: 'npm test', cwd: '/w', name: 'forge-alpha-1-0',
    });
    expect(containerName).toBe('forge-alpha-1-0');
    expect(argv[argv.indexOf('--name') + 1]).toBe('forge-alpha-1-0');
  });

  it('reaps by name with a forced remove', () => {
    expect(sandboxReapCommand(config, 'forge-alpha-1-0'))
      .toEqual(['docker', 'rm', '-f', 'forge-alpha-1-0']);
  });

  it('flattens a run name that is not a legal container name', () => {
    expect(containerNameFor('LUCK-5/feature:x', 2)).toBe('forge-LUCK-5-feature-x-2');
    expect(containerNameFor('///', 0)).toBe('forge-run-0');
  });

  it('reports containment honestly when disabled, and does not wrap', () => {
    const off = readSandboxConfig({ FORGE_SANDBOX: '0' });
    const result = sandboxCommand(off, { command: 'npm test', cwd: '/w' });
    expect(result).toEqual({ argv: ['npm test'], contained: false });
  });
});

describe('describeSandbox', () => {
  it('says plainly when nothing contained the run, and why', () => {
    expect(describeSandbox(readSandboxConfig({ FORGE_SANDBOX: '0' })))
      .toMatch(/FORGE_SANDBOX=0/);
  });

  it('names the image, network and user when it did', () => {
    const line = describeSandbox(readSandboxConfig({}));
    expect(line).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(line).toContain('network=none');
    expect(line).toContain('user=1000:1000');
  });
});

describe('run clone git inside the container', () => {
  it('mounts an in-container alternates file and sets autocrlf and safe.directory', async () => {
    const { sandboxCommand, readSandboxConfig } = await import('../../src/forge/sandbox-exec.js');
    const boxed = sandboxCommand(readSandboxConfig({}), {
      command: 'git status', cwd: 'C:/wt/x', name: 'n',
      runClone: { hostClonePath: 'C:/wt/x', hostPrimaryObjects: 'C:/p/.git/objects', containerAlternatesFile: 'C:/h/alternates' },
    });
    const argv = boxed.argv.join(' ');
    expect(argv).toContain('/c/h/alternates:/work/.git/objects/info/alternates:ro');
    expect(argv).toContain('GIT_CONFIG_VALUE_0=true');
    expect(argv).toContain('GIT_CONFIG_KEY_1=safe.directory');
  });
});
