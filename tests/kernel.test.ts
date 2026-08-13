import { describe, expect, it } from 'vitest';

import { Kernel, type ApprovalDecision, type ApprovalRequest } from '../src/kernel/kernel.ts';
import { authorshipGuard } from '../src/kernel/guards/authorship.ts';
import { convergenceGuard } from '../src/kernel/guards/convergence.ts';
import { subagentTierGuard } from '../src/kernel/guards/subagent-tier.ts';
import type { Guard, GuardNote, PermissionMode, ToolCall } from '../src/types.ts';
import { AUTHORSHIP_SPECIMENS } from './specimens/authorship.ts';
import { NONE_OF_THREE } from './specimens/convergence.ts';

class FakeControls {
  models: Array<string | undefined> = [];
  modes: PermissionMode[] = [];
  async setModel(model: string | undefined): Promise<void> {
    this.models.push(model);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode);
  }
}

function build(options: { guards?: Guard[]; approve?: (r: ApprovalRequest) => ApprovalDecision } = {}) {
  const controls = new FakeControls();
  const notes: GuardNote[] = [];
  const seen: ApprovalRequest[] = [];
  const kernel = new Kernel({
    cwd: '/tmp',
    controls,
    guards: options.guards ?? [],
    onNote: (note) => notes.push(note),
    approve: async (request) => {
      seen.push(request);
      return options.approve ? options.approve(request) : { allow: true };
    },
  });
  return { kernel, controls, notes, seen };
}

const call = (toolName: string, input: Record<string, unknown> = {}): ToolCall => ({
  toolName,
  input,
});

describe('phase routing', () => {
  it('sets the plan model and plan mode together when planning starts', async () => {
    const { kernel, controls } = build();
    await kernel.enterPlanning();
    expect(kernel.state.phase).toBe('planning');
    expect(controls.models).toEqual(['claude-fable-5']);
    expect(controls.modes).toEqual(['plan']);
  });

  it('switches to the implementation model when a plan is approved', async () => {
    const { kernel, controls } = build();
    await kernel.enterPlanning();
    await kernel.decide(call('ExitPlanMode', { plan: 'anything' }));
    expect(kernel.state.phase).toBe('implementation');
    expect(kernel.state.planApproved).toBe(true);
    expect(controls.models).toEqual(['claude-fable-5', 'claude-opus-5']);
  });

  it('stays in planning on the plan model when the plan is turned down', async () => {
    const { kernel, controls } = build({ approve: () => ({ allow: false, reason: 'not yet' }) });
    await kernel.enterPlanning();
    const result = await kernel.decide(call('ExitPlanMode', { plan: 'anything' }));
    expect(result.allow).toBe(false);
    expect(kernel.state.phase).toBe('planning');
    expect(kernel.state.planApproved).toBe(false);
    expect(controls.models).toEqual(['claude-fable-5']);
  });

  it('requires no particular model during ordinary conversation', () => {
    const { kernel } = build();
    expect(kernel.requiredModel('conversation')).toBeNull();
  });

  it('ends the implementation phase when planning starts again', async () => {
    const { kernel } = build();
    await kernel.enterPlanning();
    await kernel.decide(call('ExitPlanMode', { plan: 'x' }));
    expect(kernel.state.planApproved).toBe(true);
    await kernel.enterPlanning();
    expect(kernel.state.planApproved).toBe(false);
  });

  it('keeps a manual model override across a phase change', async () => {
    const { kernel, controls } = build();
    await kernel.overrideModel('claude-sonnet-5');
    await kernel.enterPlanning();
    expect(controls.models).toEqual(['claude-sonnet-5']);
    expect(kernel.state.selectedModel).toBe('claude-sonnet-5');
  });

  it('reports a reroute when the answering model is not the one asked for', async () => {
    const { kernel } = build();
    await kernel.enterPlanning();
    expect(kernel.rerouted).toBe(false);
    kernel.recordServingModel('claude-opus-4-8');
    expect(kernel.rerouted).toBe(true);
  });
});

describe('subagent tier correction', () => {
  const guards = [subagentTierGuard];

  it('corrects a research subagent that named no model', () => {
    const { kernel } = build({ guards });
    const verdict = kernel.inspect(call('Agent', { subagent_type: 'Explore', prompt: 'x' }));
    expect(verdict.updatedInput?.['model']).toBe('sonnet');
    expect(verdict.decision).toBeUndefined();
  });

  it('corrects a research subagent asked for on the wrong tier', () => {
    const { kernel } = build({ guards });
    const verdict = kernel.inspect(
      call('Agent', { subagent_type: 'Explore', model: 'opus', prompt: 'x' }),
    );
    expect(verdict.updatedInput?.['model']).toBe('sonnet');
  });

  it('leaves a correctly tiered call alone', () => {
    const { kernel } = build({ guards });
    const verdict = kernel.inspect(call('Agent', { subagent_type: 'Plan', model: 'fable', prompt: 'x' }));
    expect(verdict.updatedInput).toBeUndefined();
  });

  it('treats an unlisted subagent as research', () => {
    const { kernel } = build({ guards });
    const verdict = kernel.inspect(
      call('Agent', { subagent_type: 'something-new', model: 'claude-opus-4-8', prompt: 'x' }),
    );
    expect(verdict.updatedInput?.['model']).toBe('sonnet');
  });
});

describe('guard orchestration', () => {
  it('refuses a call a guard denied', () => {
    // Pulled from the corpus rather than written inline, so the payload has one
    // home and this file never has to contain the strings the guard bans.
    const banned = AUTHORSHIP_SPECIMENS.find((s) => s.expect === 'deny');
    expect(banned).toBeDefined();
    const { kernel } = build({ guards: [authorshipGuard] });
    const verdict = kernel.inspect(banned!.input);
    expect(verdict.decision).toBe('deny');
  });

  it('says nothing about a call no guard objected to, leaving the rules in charge', () => {
    const { kernel } = build({ guards: [authorshipGuard] });
    const verdict = kernel.inspect(call('Bash', { command: 'ls -la' }));
    // Never 'allow'. Handing out permission as a side effect of checking
    // something is how a guard becomes a way around the human.
    expect(verdict.decision).toBeUndefined();
  });

  it('escalates an objected-to call so the objection is actually read', () => {
    const { kernel } = build({ guards: [convergenceGuard] });
    const verdict = kernel.inspect(call('ExitPlanMode', { plan: NONE_OF_THREE }), 'tu-1');
    expect(verdict.decision).toBe('ask');
    expect(verdict.notes.map((n) => n.message).join(' ')).toContain('falsifier');
  });

  it('carries objections from the inspection through to the approval screen', async () => {
    const { kernel, seen } = build({ guards: [convergenceGuard] });
    kernel.inspect(call('ExitPlanMode', { plan: NONE_OF_THREE }), 'tu-2');
    const result = await kernel.decide(call('ExitPlanMode', { plan: NONE_OF_THREE }), 'tu-2');
    expect(result.allow).toBe(true);
    expect(seen[0]?.isPlanApproval).toBe(true);
    expect(seen[0]?.notes.map((n) => n.message).join(' ')).toContain('falsifier');
  });

  it('always asks about a plan, even one it had nothing to say about', () => {
    const { kernel } = build({ guards: [] });
    expect(kernel.inspect(call('ExitPlanMode', { plan: 'x' })).decision).toBe('ask');
  });
});

describe('failure semantics', () => {
  const exploding: Guard = {
    name: 'exploding',
    decide() {
      throw new Error('boom');
    },
    observe() {
      throw new Error('boom');
    },
  };

  it('switches off a guard that throws and lets the call continue', () => {
    const { kernel, notes } = build({ guards: [exploding] });
    const verdict = kernel.inspect(call('Bash', { command: 'ls' }));
    // Fails open on a hot path. The session survives, and the fact that it is
    // no longer being checked is stated rather than swallowed.
    expect(verdict.decision).toBeUndefined();
    expect(kernel.health.healthy).toBe(false);
    expect(kernel.health.disabled).toContain('exploding');
    expect(notes.some((n) => n.message.includes('UNCHECKED'))).toBe(true);
  });

  it('reports the failure once rather than on every call', () => {
    const { kernel } = build({ guards: [exploding] });
    kernel.inspect(call('Bash', { command: 'ls' }));
    kernel.inspect(call('Bash', { command: 'ls' }));
    expect(kernel.health.failures).toHaveLength(1);
  });

  it('survives a guard that throws while observing', () => {
    const { kernel } = build({ guards: [exploding] });
    expect(() => kernel.observe({ type: 'prompt', text: 'hello' })).not.toThrow();
    expect(kernel.health.healthy).toBe(false);
  });

  it('starts healthy', () => {
    const { kernel } = build({ guards: [authorshipGuard] });
    expect(kernel.health.healthy).toBe(true);
    expect(kernel.health.disabled).toEqual([]);
  });
});
