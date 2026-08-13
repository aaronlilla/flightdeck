/**
 * The interface states worth asserting.
 *
 * These are the conditions a person has to be able to see: which phase is
 * running, whether the answering model is the one that was asked for, and
 * whether enforcement is still running at all. They live as values rather than
 * as rendered terminal output so that they can be checked directly.
 */
import { describe, expect, it } from 'vitest';

import { buildDiff, buildStatusBar, completions, shortModel, toolSummary } from '../src/cockpit/format.ts';
import { initialSessionState, type KernelHealth, type SessionState } from '../src/types.ts';

const healthy: KernelHealth = { healthy: true, disabled: [], failures: [] };

function state(overrides: Partial<SessionState> = {}): SessionState {
  return { ...initialSessionState('/tmp'), ...overrides };
}

describe('status bar', () => {
  it('shows the phase and the selected model', () => {
    const bar = buildStatusBar(
      state({ phase: 'planning', selectedModel: 'claude-fable-5' }),
      healthy,
      null,
    );
    expect(bar.phase).toBe('planning');
    expect(bar.model).toBe('fable');
    expect(bar.reroute).toBeNull();
    expect(bar.alarm).toBeNull();
  });

  it('stays quiet when the answering model matches', () => {
    const bar = buildStatusBar(
      state({ selectedModel: 'claude-opus-5', servingModel: 'claude-opus-5' }),
      healthy,
      null,
    );
    expect(bar.reroute).toBeNull();
  });

  it('shows the answering model when it is not the one asked for', () => {
    // The condition the old gate could only record as a known hole.
    const bar = buildStatusBar(
      state({ selectedModel: 'claude-fable-5', servingModel: 'claude-opus-4-8' }),
      healthy,
      null,
    );
    expect(bar.reroute).toBe('serving opus-4-8');
  });

  it('marks a pinned model so the router is not blamed for it', () => {
    const bar = buildStatusBar(
      state({ selectedModel: 'claude-sonnet-5', modelOverride: 'claude-sonnet-5' }),
      healthy,
      null,
    );
    expect(bar.model).toBe('sonnet (pinned)');
  });

  it('raises an alarm when a guard has failed', () => {
    const bar = buildStatusBar(state(), {
      healthy: false,
      disabled: ['authorship'],
      failures: ['authorship: boom'],
    }, null);
    expect(bar.alarm).toContain('UNCHECKED');
    expect(bar.alarm).toContain('authorship');
  });

  it('reports remaining context when the engine supplied it', () => {
    expect(buildStatusBar(state(), healthy, 51200).context).toBe('51k left');
    expect(buildStatusBar(state(), healthy, null).context).toBeNull();
  });

  it('reads an unknown model as unknown rather than as nothing', () => {
    expect(shortModel(null)).toBe('unknown');
    expect(shortModel('claude-fable-5')).toBe('fable');
    expect(shortModel('claude-opus-5[1m]')).toBe('opus');
  });
});

describe('tool summaries', () => {
  it('names the file for a write', () => {
    expect(toolSummary('Write', { file_path: 'src/a.ts' })).toBe('Write  src/a.ts');
  });

  it('shows the first line of a command', () => {
    expect(toolSummary('Bash', { command: 'npm test\nmore' })).toBe('Bash  npm test');
  });

  it('shows a subagent with its tier', () => {
    expect(toolSummary('Agent', { subagent_type: 'Explore', model: 'sonnet' })).toBe(
      'Agent  Explore on sonnet',
    );
  });
});

describe('diffs', () => {
  it('shows what leaves and what arrives on an edit', () => {
    const diff = buildDiff('Edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two' });
    expect(diff.find((l) => l.kind === 'remove')?.text).toBe('one');
    expect(diff.find((l) => l.kind === 'add')?.text).toBe('two');
  });

  it('says how much a long write was truncated by', () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const diff = buildDiff('Write', { file_path: 'a.ts', content }, 10);
    expect(diff.some((l) => l.text.includes('40 more lines'))).toBe(true);
  });
});

describe('slash palette', () => {
  it('offers matching local commands', () => {
    expect(completions('/pl').map((c) => c.name)).toEqual(['/plan']);
  });

  it('offers nothing for ordinary text', () => {
    expect(completions('write a test')).toEqual([]);
  });
});
