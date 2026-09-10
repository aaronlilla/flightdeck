/**
 * The Codex advisor's whole point is that `ask` never blocks a tick. The falsifier: an
 * implementation that awaits the Codex turn itself (via `result`) inside `ask` would
 * pass every other check while reintroducing the fifteen-minute block this goal exists
 * to remove -- the "returns before the runner resolves" test is the detector for that.
 */
import { describe, expect, it, vi } from 'vitest';

import { argvFor, CodexAdvisor, type CodexAdvisorRunner } from '../../../src/forge/council/codexAdvisor.js';

describe('argvFor', () => {
  it('builds the exact start argv, prompt and label always present, model only when named', () => {
    expect(argvFor({ prompt: 'hello', cwd: 'D:\\repo', label: 'ping' }))
      .toEqual(['start', '--run', '--cwd', 'D:\\repo', '--prompt', 'hello', '--label', 'ping']);
  });

  it('appends --model only when the caller names one', () => {
    expect(argvFor({ prompt: 'hello', cwd: 'D:\\repo', label: 'ping', model: 'ping' }))
      .toEqual(['start', '--run', '--cwd', 'D:\\repo', '--prompt', 'hello', '--label', 'ping', '--model', 'ping']);
  });
});

describe('CodexAdvisor.ask', () => {
  it('returns the run id as soon as start resolves, never waiting on status or result', async () => {
    let startResolved = false;
    const runner: CodexAdvisorRunner = {
      start: vi.fn(async () => {
        startResolved = true;
        return { runId: 'run-42' };
      }),
      status: vi.fn(async () => ({ state: 'running' })),
      result: vi.fn(() => new Promise<never>(() => { /* never resolves -- proves ask never awaits this */ })),
    };
    const journal = { append: vi.fn() };
    const advisor = new CodexAdvisor({ runner, journal });

    const outcome = await advisor.ask({ prompt: 'is this design safe?', cwd: 'D:\\repo', label: 'safety-check' });

    expect(startResolved).toBe(true);
    expect(outcome).toEqual({ id: 'run-42' });
    expect(runner.status).not.toHaveBeenCalled();
    expect(runner.result).not.toHaveBeenCalled();
  });

  it('journals codex.started with only the id and the label, never the prompt', async () => {
    const journal = { append: vi.fn() };
    const runner: CodexAdvisorRunner = {
      start: vi.fn(async () => ({ runId: 'run-1' })),
      status: vi.fn(),
      result: vi.fn(),
    };
    const advisor = new CodexAdvisor({ runner, journal });
    await advisor.ask({ prompt: 'a secret prompt nobody should journal', cwd: 'D:\\repo', label: 'review' });
    expect(journal.append).toHaveBeenCalledTimes(1);
    const row = journal.append.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['event']).toBe('codex.started');
    expect(row['id']).toBe('run-1');
    expect(row['label']).toBe('review');
    expect(JSON.stringify(row)).not.toContain('a secret prompt');
  });
});

describe('CodexAdvisor.status', () => {
  it('maps the runner\'s own status verb through unchanged', async () => {
    const runner: CodexAdvisorRunner = {
      start: vi.fn(), status: vi.fn(async () => ({ state: 'done', exitCode: 0 })), result: vi.fn(),
    };
    const advisor = new CodexAdvisor({ runner, journal: { append: vi.fn() } });
    expect(await advisor.status('run-1')).toEqual({ state: 'done', exitCode: 0 });
  });
});

describe('CodexAdvisor.result', () => {
  it('journals codex.finished with the id, exit code and seconds -- never the prompt or output text', async () => {
    const journal = { append: vi.fn() };
    const runner: CodexAdvisorRunner = {
      start: vi.fn(),
      status: vi.fn(),
      result: vi.fn(async () => ({ exitCode: 0, seconds: 42, ok: true, output: 'the model\'s secret answer text' })),
    };
    const advisor = new CodexAdvisor({ runner, journal });
    const outcome = await advisor.result('run-1');
    expect(outcome.exitCode).toBe(0);
    expect(journal.append).toHaveBeenCalledWith({ event: 'codex.finished', id: 'run-1', exitCode: 0, seconds: 42 });
    expect(JSON.stringify(journal.append.mock.calls[0]?.[0])).not.toContain('secret answer');
  });
});
