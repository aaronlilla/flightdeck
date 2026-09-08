import { describe, it, expect } from 'vitest';
import {
  decideServerMode, buildStartCommand, parseEnvCmd, planStart, type StartCommandFs,
} from '../server-mode';

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

describe('parseEnvCmd', () => {
  it('parses set lines, ignoring rem and echo lines, keeping = in values', () => {
    const content = [
      '@echo off',
      'rem this is the console-of-record environment',
      '@rem another comment style',
      'set FORGE_QUEUE=on',
      'set FORGE_JIRA_TOKEN=abc=def=ghi',
      '',
      'set FORGE_SELF_REPO=C:\\dev\\flightdeck',
    ].join('\r\n');
    expect(parseEnvCmd(content)).toEqual({
      FORGE_QUEUE: 'on',
      FORGE_JIRA_TOKEN: 'abc=def=ghi',
      FORGE_SELF_REPO: 'C:\\dev\\flightdeck',
    });
  });

  it('returns an empty object for a file with no set lines', () => {
    expect(parseEnvCmd('@echo off\r\nrem nothing here\r\n')).toEqual({});
  });
});

describe('planStart', () => {
  it('plans the launcher script when console.launch.cmd exists, on Windows', () => {
    const fs: StartCommandFs = { existsSync: (p) => p === '/home/.forge/console.launch.cmd' };
    const plan = planStart(fs, join, '/repo', '/apps/Console.exe', '/home', 'win32');
    expect(plan.kind).toBe('launcher');
    if (plan.kind !== 'launcher') throw new Error('expected launcher plan');
    expect(plan.scriptPath).toBe('/home/.forge/console.launch.cmd');
    expect(plan.command).toBe('powershell');
    expect(plan.args.join(' ')).toContain('Win32_Process');
    expect(plan.args.join(' ')).toContain('/home/.forge/console.launch.cmd');
  });

  it('runs the launcher script directly off Windows', () => {
    const fs: StartCommandFs = { existsSync: (p) => p === '/home/.forge/console.launch.cmd' };
    const plan = planStart(fs, join, '/repo', '/apps/Console.exe', '/home', 'linux');
    expect(plan).toEqual({
      kind: 'launcher',
      command: '/home/.forge/console.launch.cmd',
      args: [],
      cwd: '/home',
      env: {},
      scriptPath: '/home/.forge/console.launch.cmd',
    });
  });

  it('falls back to the plain command with no env file when neither file exists', () => {
    const fs: StartCommandFs = { existsSync: () => false };
    const plan = planStart(fs, join, '/repo', '/usr/bin/node', '/home', 'win32');
    expect(plan).toEqual({
      kind: 'command',
      command: 'npm.cmd',
      args: ['run', 'forge', '--', 'up'],
      cwd: '/repo',
      env: {},
      envFileVarsCount: 0,
    });
  });

  it('merges console.env.cmd settings into the fallback command when there is no launcher', () => {
    const envFile = '/home/.forge/console.env.cmd';
    const fs: StartCommandFs = {
      existsSync: (p) => p === '/repo/dist/forge/cli.js' || p === envFile,
      readFileSync: (p, _encoding) => (p === envFile ? 'set FORGE_QUEUE=on\r\nrem comment\r\nset FORGE_JIRA_TOKEN=abc=def\r\n' : ''),
    };
    const plan = planStart(fs, join, '/repo', '/apps/Console.exe', '/home', 'win32');
    expect(plan).toEqual({
      kind: 'command',
      command: '/apps/Console.exe',
      args: ['/repo/dist/forge/cli.js', 'up'],
      cwd: '/repo',
      env: { ELECTRON_RUN_AS_NODE: '1', FORGE_QUEUE: 'on', FORGE_JIRA_TOKEN: 'abc=def' },
      envFileVarsCount: 2,
    });
  });
});
