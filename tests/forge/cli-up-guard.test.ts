/**
 * Item 3, 2026-09-10: `forge up` used to die silently on a held port -- the bind
 * rejection reached only the global `unhandledRejection` handler ("console stays
 * up"), logged a line, and the process drained and exited 0. These tests never touch
 * the real 4120 (that is the live console other sessions depend on): each binds its
 * own throwaway listener on an ephemeral port and points `up` at it via `FORGE_PORT`.
 */
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.js';

let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'forge-cli-up-guard-'));
  process.env['FORGE_HOME'] = home;
  process.env['FORGE_CONFIG_DIR'] = join(home, 'claude');
  delete process.env['FORGE_LAUNCHER'];
  // Every case in this file, including ones that never reach the bind attempt (the
  // launcher-guard refusal), pins FORGE_PORT to an ephemeral port up front -- the real
  // 4120 is the live console other sessions depend on and must never be touched, not
  // even by a failed bind attempt from unmodified code under test.
  process.env['FORGE_PORT'] = String(await ephemeralPort());
});

afterEach(() => {
  delete process.env['FORGE_PORT'];
  delete process.env['FORGE_LAUNCHER'];
});

function bindThrowaway(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('forge up: a held port', () => {
  it('exits 76 naming the holder pid, instead of exiting 0', async () => {
    const port = await ephemeralPort();
    const holder = await bindThrowaway(port);
    process.env['FORGE_PORT'] = String(port);

    const result = await forge(['up', '--here']);

    expect(result.code).toBe(76);
    expect(result.lines.join('\n')).toMatch(new RegExp(`${port} is held by pid \\d+`));

    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }, 20000);
});

describe('forge up: the console-of-record launcher guard', () => {
  it('refuses without FORGE_LAUNCHER=1 or --here when console.launch.cmd exists', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'console.launch.cmd'), '@echo off\r\n', 'utf8');

    const result = await forge(['up']);

    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('console.launch.cmd');
    expect(result.lines.join('\n')).toContain('--here');
  });

  it('proceeds with --here even though the launcher script exists', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'console.launch.cmd'), '@echo off\r\n', 'utf8');
    const port = await ephemeralPort();
    const holder = await bindThrowaway(port);
    process.env['FORGE_PORT'] = String(port);

    const result = await forge(['up', '--here']);

    // Proceeded past the launcher guard: reached the real bind attempt and got the
    // held-port failure, not the launcher-guard refusal.
    expect(result.code).toBe(76);
    expect(result.lines.join('\n')).not.toContain('console.launch.cmd');

    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }, 20000);
});
