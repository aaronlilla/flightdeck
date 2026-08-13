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

  it('corrects a research subagent that named no model', async () => {
    const { kernel, seen } = build({ guards });
    const result = await kernel.decide(call('Agent', { subagent_type: 'Explore', prompt: 'x' }));
    expect(result.allow).toBe(true);
    expect(seen[0]?.call.input['model']).toBe('sonnet');
    expect((result as { input?: Record<string, unknown> }).input?.['model']).toBe('sonnet');
  });

  it('corrects a research subagent asked for on the wrong tier', async () => {
    const { kernel } = build({ guards });
    const result = await kernel.decide(
      call('Agent', { subagent_type: 'Explore', model: 'opus', prompt: 'x' }),
    );
    expect((result as { input?: Record<string, unknown> }).input?.['model']).toBe('sonnet');
  });

  it('leaves a correctly tiered call alone', async () => {
    const { kernel, seen } = build({ guards });
    await kernel.decide(call('Agent', { subagent_type: 'Plan', model: 'fable', prompt: 'x' }));
    expect(seen[0]?.call.input['model']).toBe('fable');
  });

  it('treats an unlisted subagent as research', async () => {
    const { kernel, seen } = build({ guards });
    await kernel.decide(
      call('Agent', { subagent_type: 'something-new', model: 'claude-opus-4-8', prompt: 'x' }),
    );
    expect(seen[0]?.call.input['model']).toBe('sonnet');
  });
});

describe('guard orchestration', () => {
  it('refuses a call a guard denied, without asking the human', async () => {
    // Pulled from the corpus rather than written inline, so the payload has one
    // home and this file never has to contain the strings the guard bans.
    const banned = AUTHORSHIP_SPECIMENS.find((s) => s.expect === 'deny');
    expect(banned).toBeDefined();
    const { kernel, seen } = build({ guards: [authorshipGuard] });
    const result = await kernel.decide(banned!.input);
    expect(result.allow).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('carries guard objections to the approval screen instead of refusing', async () => {
    const { kernel, seen } = build({ guards: [convergenceGuard] });
    const result = await kernel.decide(call('ExitPlanMode', { plan: NONE_OF_THREE }));
    expect(result.allow).toBe(true);
    expect(seen[0]?.isPlanApproval).toBe(true);
    expect(seen[0]?.notes.length).toBeGreaterThan(0);
    expect(seen[0]?.notes.map((n) => n.message).join(' ')).toContain('falsifier');
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

  it('switches off a guard that throws and keeps the session alive', async () => {
    const { kernel, notes } = build({ guards: [exploding] });
    const result = await kernel.decide(call('Bash', { command: 'ls' }));
    expect(result.allow).toBe(true);
    expect(kernel.health.healthy).toBe(false);
    expect(kernel.health.disabled).toContain('exploding');
    expect(notes.some((n) => n.message.includes('UNCHECKED'))).toBe(true);
  });

  it('reports the failure once rather than on every call', async () => {
    const { kernel } = build({ guards: [exploding] });
    await kernel.decide(call('Bash', { command: 'ls' }));
    await kernel.decide(call('Bash', { command: 'ls' }));
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
