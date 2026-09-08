/**
 * loadConsoleEnv fills a terminal `forge` run with the same FORGE_* variables the
 * console already has, without letting the file override anything the shell set.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConsoleEnv } from '../../src/forge/console-env.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-console-env-'));
  filePath = join(dir, 'console.env.cmd');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConsoleEnv', () => {
  it('parses set lines, including a CRLF file, a value with =, a blank line, and a non-set line', () => {
    writeFileSync(
      filePath,
      [
        'set FORGE_COUNCIL_REPOS=BOLTBETZ-LLC/v2-React-Native,BOLTBETZ-LLC/bb-infra',
        'set FORGE_INTAKE_REPO_MAP=a=1,b=2',
        '',
        'rem this is a comment, not a set line',
        'set FORGE_QUEUE_POLL_S=30',
      ].join('\r\n'),
    );

    const env: NodeJS.ProcessEnv = {};
    const filled = loadConsoleEnv(filePath, env);

    expect(env['FORGE_COUNCIL_REPOS']).toBe('BOLTBETZ-LLC/v2-React-Native,BOLTBETZ-LLC/bb-infra');
    expect(env['FORGE_INTAKE_REPO_MAP']).toBe('a=1,b=2');
    expect(env['FORGE_QUEUE_POLL_S']).toBe('30');
    expect(filled).toEqual(['FORGE_COUNCIL_REPOS', 'FORGE_INTAKE_REPO_MAP', 'FORGE_QUEUE_POLL_S']);
  });

  it('never overrides a variable the calling environment already set', () => {
    writeFileSync(filePath, 'set FORGE_COUNCIL_REPOS=from-file\r\n');

    const env: NodeJS.ProcessEnv = { FORGE_COUNCIL_REPOS: 'from-shell' };
    const filled = loadConsoleEnv(filePath, env);

    expect(env['FORGE_COUNCIL_REPOS']).toBe('from-shell');
    expect(filled).toEqual([]);
  });

  it('returns an empty list when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    const filled = loadConsoleEnv(join(dir, 'missing.cmd'), env);

    expect(filled).toEqual([]);
    expect(env).toEqual({});
  });
});
