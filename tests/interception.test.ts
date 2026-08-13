/**
 * Regression cover for an escape.
 *
 * The guards were originally hung off the permission callback. A live session
 * then ran a shell command without the kernel being consulted at all, because
 * a permission rule in the loaded settings already allowed it and the callback
 * is skipped in that case. Nothing caught it: the smoke test asserted that a
 * tool call had happened and reported that as the kernel having seen it.
 *
 * The fix moved the guards to PreToolUse, which fires for every tool call. The
 * tests below hold that wiring in place, because the failure is silent by
 * nature: guards that are never called look exactly like guards that found
 * nothing wrong.
 */
import { describe, expect, it } from 'vitest';

import { buildOptions } from '../src/adapter/engine.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { authorshipGuard } from '../src/kernel/guards/authorship.ts';
import type { ToolCall } from '../src/types.ts';
import { AUTHORSHIP_SPECIMENS } from './specimens/authorship.ts';

function kernelWith(guards = [authorshipGuard]) {
  return new Kernel({
    cwd: '/tmp',
    controls: { setModel: async () => {}, setPermissionMode: async () => {} },
    onNote: () => {},
    approve: async () => ({ allow: true }),
    guards,
  });
}

const baseConfig = {
  cwd: '/tmp',
  canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
};

describe('the engine registers a PreToolUse hook', () => {
  it('turns onToolCall into a PreToolUse hook rather than dropping it', () => {
    const options = buildOptions({ ...baseConfig, onToolCall: () => ({ decision: undefined }) });
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it('registers no hook when nothing asked to inspect', () => {
    expect(buildOptions(baseConfig).hooks).toBeUndefined();
  });

  it('forwards the tool name, input and id to the inspector', async () => {
    const seen: Array<{ toolName: string; toolUseId: string }> = [];
    const options = buildOptions({
      ...baseConfig,
      onToolCall: ({ toolName, toolUseId }) => {
        seen.push({ toolName, toolUseId });
        return { decision: undefined };
      },
    });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    await hook?.(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { a: 1 } } as never,
      'tu-9',
      { signal: new AbortController().signal },
    );
    expect(seen).toEqual([{ toolName: 'Write', toolUseId: 'tu-9' }]);
  });

  it('stops the call when the inspector refused it', async () => {
    const options = buildOptions({
      ...baseConfig,
      onToolCall: () => ({ decision: 'deny' as const, reason: 'no' }),
    });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const result = (await hook?.(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} } as never,
      'tu-1',
      { signal: new AbortController().signal },
    )) as { continue?: boolean; hookSpecificOutput?: Record<string, unknown> };
    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput?.['permissionDecision']).toBe('deny');
  });

  it('carries a corrected input back to the engine', async () => {
    const options = buildOptions({
      ...baseConfig,
      onToolCall: () => ({ decision: undefined, updatedInput: { model: 'sonnet' } }),
    });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const result = (await hook?.(
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} } as never,
      'tu-2',
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: Record<string, unknown> };
    expect(result.hookSpecificOutput?.['updatedInput']).toEqual({ model: 'sonnet' });
  });
});

describe('guards run at the point that sees every call', () => {
  const banned = AUTHORSHIP_SPECIMENS.find((s) => s.expect === 'deny')!;

  it('refuses a banned write through inspect, which PreToolUse calls', () => {
    const kernel = kernelWith();
    expect(kernel.inspect(banned.input).decision).toBe('deny');
  });

  it('never answers allow, so a check can never hand out permission', () => {
    const kernel = kernelWith();
    const calls: ToolCall[] = [
      { toolName: 'Bash', input: { command: 'ls' } },
      { toolName: 'Read', input: { file_path: 'a.ts' } },
      { toolName: 'Write', input: { file_path: 'a.ts', content: 'const a = 1;' } },
    ];
    for (const call of calls) {
      const verdict = kernel.inspect(call);
      // Only 'deny', 'ask', or nothing. Answering 'allow' would let a guard
      // approve a tool the human would otherwise have been asked about.
      expect(verdict.decision === undefined || verdict.decision === 'deny' || verdict.decision === 'ask').toBe(true);
      expect(verdict.decision as string).not.toBe('allow');
    }
  });

  it('escalates to ask when it has something to say, so the note is read', () => {
    const kernel = kernelWith([
      {
        name: 'noisy',
        decide: () => ({
          kind: 'annotate' as const,
          notes: [{ guard: 'noisy', severity: 'blocking' as const, message: 'look at this' }],
        }),
      },
    ]);
    const verdict = kernel.inspect({ toolName: 'Bash', input: { command: 'ls' } });
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toContain('look at this');
  });

  it('stays silent when a guard only has information to add', () => {
    const kernel = kernelWith([
      {
        name: 'quiet',
        decide: () => ({
          kind: 'annotate' as const,
          notes: [{ guard: 'quiet', severity: 'info' as const, message: 'noted' }],
        }),
      },
    ]);
    // An informational note must not interrupt. Turning every remark into a
    // prompt is how a guard trains its owner to approve without reading.
    expect(kernel.inspect({ toolName: 'Bash', input: { command: 'ls' } }).decision).toBeUndefined();
  });
});
