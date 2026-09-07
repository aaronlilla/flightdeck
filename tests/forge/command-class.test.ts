import { describe, expect, it } from 'vitest';

import { classifyCommand } from '../../src/forge/command-class.js';
import { CLASS_BUDGETS } from '../../src/forge/exec.js';
import { replay } from '../../src/forge/journal.js';
import { assess } from '../../src/forge/liveness.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('classifyCommand', () => {
  it.each([
    ['dotnet build --nologo', 'build'],
    ['npm run build', 'build'],
    ['./gradlew assembleDebug', 'build'],
    ['npx tsc --noEmit', 'build'],
    ['dotnet test --no-build', 'test'],
    ['npx jest --ci --silent', 'test'],
    ['npx vitest run tests/x.test.ts', 'test'],
    ['npx playwright test', 'test'],
    ['npm ci --no-audit', 'install'],
    ['dotnet restore', 'install'],
    ['pip install -r requirements.txt', 'install'],
    ['git status --short', 'script'],
    ['ls -la', 'script'],
    ['cd repo && npm ci && npm test', 'test'],
  ])('%s is %s', (command, cls) => {
    expect(classifyCommand(command)).toBe(cls);
  });
});

describe('liveness reads the tool class the journal recorded', () => {
  function journalWith(rows: Array<Record<string, unknown>>): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-cls-'));
    const path = join(dir, 'fleet.jsonl');
    writeFileSync(path, rows.map((row, i) => JSON.stringify({ id: `e${i}`, seq: i + 1, version: 1, ...row })).join('\n') + '\n');
    return path;
  }

  it('a build-class Bash call three minutes in does not trip the tool budget', () => {
    const t0 = 1_000_000;
    const path = journalWith([
      { at: t0, event: 'run.started', run: 'r1', actor: 'runner', model: 'm', className: 'implement', maxContext: 150000 },
      { at: t0 + 1000, event: 'tool.start', run: 'r1', actor: 'worker', tool: 'Bash', cls: 'build' },
    ]);
    const state = replay(path);
    const run = state.runs['r1']!;
    expect(run.currentTool?.cls).toBe('build');
    const now = t0 + 1000 + 180_000;
    const trips = assess({ now, fleet: [], runs: [{ run: 'r1', className: 'implement', lastEventAt: now - 1000, currentTool: run.currentTool!, context: 0 }] });
    expect(trips.filter((t) => t.signal === 'tool-budget')).toEqual([]);
  });

  it('a script-class call past two minutes still trips', () => {
    const t0 = 1_000_000;
    const path = journalWith([
      { at: t0, event: 'run.started', run: 'r1', actor: 'runner', model: 'm', className: 'implement', maxContext: 150000 },
      { at: t0 + 1000, event: 'tool.start', run: 'r1', actor: 'worker', tool: 'Bash', cls: 'script' },
    ]);
    const state = replay(path);
    const run = state.runs['r1']!;
    const now = t0 + 1000 + (CLASS_BUDGETS['script']!.wall + 10) * 1000;
    const trips = assess({ now, fleet: [], runs: [{ run: 'r1', className: 'implement', lastEventAt: now - 1000, currentTool: run.currentTool!, context: 0 }] });
    expect(trips.some((t) => t.signal === 'tool-budget')).toBe(true);
  });
});
