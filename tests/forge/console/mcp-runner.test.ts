import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { claudeMcpList, parseMcpListLine } from '../../../src/forge/console/mcp-runner.js';

function fakeSpawn(returncode: number | null, stdout: string, opts: { hang?: boolean } = {}) {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawnFn = (command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    if (!opts.hang) {
      setImmediate(() => {
        (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout));
        child.emit('close', returncode);
      });
    }
    return child;
  };
  return { spawnFn, calls };
}

// The exact live output captured against the fleet config dir, 2026-09-08, `claude 2.1.263`,
// plus the trailing SessionEnd hook noise line this machine's own hook config emits.
const LIVE_LIST_OUTPUT = [
  'Checking MCP server health\u2026',
  '',
  'claude.ai Slack: https://mcp.slack.com/mcp - \u2714 Connected',
  'plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication',
  'atlassian: https://mcp.atlassian.com/v1/mcp/authv2 (HTTP) - \u23f8 Pending approval (run `claude` to approve)',
  'cloudwatch: C:/tools/uv.exe tool run cloudwatch-mcp-server - \u23f8 Pending approval (run `claude` to approve)',
  'SessionEnd hook [python "C:/forge-hooks/slot_session.py"] failed: Hook cancelled',
].join('\n');

const SYNTHESIZED_FAILED_LINE = 'broken-server: https://dead.example.com/mcp - \u2717 Failed to connect: ECONNREFUSED';

describe('parseMcpListLine', () => {
  it('parses a connected HTTPS row', () => {
    expect(parseMcpListLine('claude.ai Slack: https://mcp.slack.com/mcp - \u2714 Connected')).toEqual({
      name: 'claude.ai Slack', target: 'https://mcp.slack.com/mcp', symbol: '\u2714', statusText: 'Connected',
    });
  });

  it('parses a name that itself contains colons', () => {
    const parsed = parseMcpListLine('plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication');
    expect(parsed?.name).toBe('plugin:slack:slack');
    expect(parsed?.symbol).toBe('!');
  });

  it('parses a pending-approval row whose command target itself contains a colon (a drive letter)', () => {
    const parsed = parseMcpListLine('cloudwatch: C:/tools/uv.exe tool run cloudwatch-mcp-server - \u23f8 Pending approval (run `claude` to approve)');
    expect(parsed?.name).toBe('cloudwatch');
    expect(parsed?.symbol).toBe('\u23f8');
    expect(parsed?.statusText).toBe('Pending approval (run `claude` to approve)');
  });

  it('returns null for a non-row noise line', () => {
    expect(parseMcpListLine('SessionEnd hook [python "C:/forge-hooks/slot_session.py"] failed: Hook cancelled')).toBeNull();
    expect(parseMcpListLine('Checking MCP server health\u2026')).toBeNull();
    expect(parseMcpListLine('')).toBeNull();
  });
});

describe('claudeMcpList', () => {
  it('maps all four live-observed states plus a synthesized failed row', async () => {
    const { spawnFn } = fakeSpawn(0, `${LIVE_LIST_OUTPUT}\n${SYNTHESIZED_FAILED_LINE}`);
    const result = await claudeMcpList({ spawnFn, configDir: 'C:/fake-fleet-config', cwd: 'C:/fake-workspace' });

    expect(result.ok).toBe(true);
    const byName = Object.fromEntries(result.rows.map((row) => [row.name, row]));
    expect(byName['claude.ai Slack']?.state).toBe('connected');
    expect(byName['claude.ai Slack']?.lastError).toBeNull();
    expect(byName['plugin:slack:slack']?.state).toBe('needs-login');
    expect(byName['atlassian']?.state).toBe('pending-approval');
    expect(byName['cloudwatch']?.state).toBe('pending-approval');
    expect(byName['broken-server']?.state).toBe('failed');
    expect(byName['broken-server']?.lastError).toBe('Failed to connect: ECONNREFUSED');
  });

  it('never produces a phantom row for the trailing SessionEnd hook noise line', async () => {
    const { spawnFn } = fakeSpawn(0, LIVE_LIST_OUTPUT);
    const result = await claudeMcpList({ spawnFn, configDir: 'C:/fake-fleet-config', cwd: 'C:/fake-workspace' });
    expect(result.rows.some((row) => row.name.includes('SessionEnd'))).toBe(false);
    expect(result.rows.length).toBe(4);
  });

  it('spawns claude mcp list with CLAUDE_CONFIG_DIR set to fleetConfigDir() and cwd from FORGE_WORKER_CWD, never opts.cwd or the process cwd', async () => {
    vi.stubEnv('FORGE_WORKER_CWD', 'X:/fake-fleet-workers');
    try {
      const { spawnFn, calls } = fakeSpawn(0, LIVE_LIST_OUTPUT);
      await claudeMcpList({ spawnFn, configDir: 'C:/fake-fleet-config', cwd: 'C:/fake-workspace' });

      // `claudeMcpList` first checks `claude` is on PATH (via `commandOnPath`, `where`/`which`)
      // before running the real list command -- both calls share this fake spawn.
      const listCall = calls.find((call) => call.command === 'claude');
      expect(listCall).toBeDefined();
      expect(listCall!.args).toEqual(['mcp', 'list']);
      const options = listCall!.options as { cwd?: string; env?: Record<string, string> };
      // Proves the spawned cwd came from FORGE_WORKER_CWD, not the `cwd` field on opts
      // (which was set to a different fake value above and must be ignored).
      expect(options.cwd).toBe('X:/fake-fleet-workers');
      expect(options.env?.['CLAUDE_CONFIG_DIR']).toBe('C:/fake-fleet-config');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to reading .claude.json under the fleet config dir for the server list only when claude is not on PATH, and never opens a credentials file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-fallback-'));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({
      mcpServers: { atlassian: { url: 'https://mcp.atlassian.com/v1/mcp/authv2' }, cloudwatch: { command: 'uv' } },
    }));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ secret: 'do-not-read-me' }));

    const readFileSpy = vi.fn();
    const { spawnFn: whereSpawn } = fakeSpawn(1, ''); // `claude` not found on PATH
    const result = await claudeMcpList({
      spawnFn: whereSpawn, configDir: dir, cwd: 'C:/fake-workspace',
      readFile: (path: string, encoding: BufferEncoding) => {
        readFileSpy(path);
        return require('node:fs').readFileSync(path, encoding);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.name).sort()).toEqual(['atlassian', 'cloudwatch']);
    expect(result.rows.every((r) => r.state === 'unknown')).toBe(true);
    for (const call of readFileSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/\.credentials\.json$/);
    }
  });

  it('resolves unknown within the 5s bound when the process never closes', async () => {
    const { spawnFn } = fakeSpawn(0, '', { hang: true });
    const started = Date.now();
    const result = await claudeMcpList({ spawnFn, configDir: 'C:/fake-fleet-config', cwd: 'C:/fake-workspace' });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(elapsed).toBeLessThan(5500);
  }, 10_000);
});
