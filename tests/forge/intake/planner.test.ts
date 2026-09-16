/**
 * `intake/planner.ts` against a fake `Reasoner` -- no model call in this file.
 */
import { describe, expect, it } from 'vitest';

import type { Packet, Reasoner } from '../../../src/forge/contracts.ts';
import { buildPlannerPrompt, planFromPacket } from '../../../src/forge/intake/planner.ts';

function packet(): Packet {
  return {
    id: 'jira:BBZ-1:100', ticket: 'BBZ-1', what: 'observed via jira, not yet triangulated',
    where: 'jira', evidence: ['jira:BBZ-1:100'], confidence: 'low', repo: 'unknown',
    blockedBy: [], at: 100,
  };
}

describe('planFromPacket', () => {
  it('calls the reasoner with class "plan" and returns its brief text', async () => {
    let seenClassName: string | undefined;
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) { seenClassName = input.className; return { text: '# Goal: fix it\n' }; },
    };
    const result = await planFromPacket(packet(), reasoner);
    expect(seenClassName).toBe('plan');
    expect(result.packetId).toBe('jira:BBZ-1:100');
    expect(result.ticket).toBe('BBZ-1');
    expect(result.text).toContain('# Goal:');
  });

  // C.2: brief and hotfix planning is cheaper work than a ticket triangulation and does
  // not need the full `plan` class's budget. `planFromPacket` never decides which source
  // gets which class itself (that is the queue's own call, stream A's file) -- it only
  // has to let a caller ask for a different one.
  it('C.2: calls the reasoner with a caller-supplied className when one is given', async () => {
    let seenClassName: string | undefined;
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) { seenClassName = input.className; return { text: '# Goal: fix it\n' }; },
    };
    await planFromPacket(packet(), reasoner, 'triage');
    expect(seenClassName).toBe('triage');
  });

  it('never writes a file itself', async () => {
    // No fs import in this test at all -- planFromPacket has no side effect to check
    // for, which is the point: writing the brief is cli.ts's job, not this module's.
    const reasoner: Reasoner = { provider: 'claude', async call() { return { text: 'x' }; } };
    const result = await planFromPacket(packet(), reasoner);
    expect(typeof result.text).toBe('string');
  });

  it('passes the built prompt to the reasoner and returns its text unchanged', async () => {
    let seenPrompt: string | undefined;
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) { seenPrompt = input.prompt; return { text: '# Goal: fix it\n' }; },
    };
    const result = await planFromPacket(packet(), reasoner);
    expect(seenPrompt).toBe(buildPlannerPrompt(packet()));
    expect(result.text).toBe('# Goal: fix it\n');
  });
});

// BBZ-175 specimen: the reasoner has no tools and no device, so an unruled prompt let it
// ask a worker for iOS/Android screenshots and a snapshot test, and cite a screen by name
// instead of a path. This rules block is what keeps the next brief from doing that again.
describe('buildPlannerPrompt', () => {
  const prompt = buildPlannerPrompt(packet());

  it('still carries the packet id and the "# Goal:" instruction', () => {
    expect(prompt).toContain('jira:BBZ-1:100');
    expect(prompt).toContain('# Goal:');
  });

  it('forbids device/screenshot verification by the worker', () => {
    expect(prompt.toLowerCase()).toContain('screenshot');
    expect(prompt.toLowerCase()).toContain('haiping');
  });

  it('forbids snapshot tests', () => {
    expect(prompt.toLowerCase()).toContain('snapshot');
  });

  it('requires file:line citation from a first status update', () => {
    expect(prompt.toLowerCase()).toContain('file:line');
  });

  it('forbids stubs and placeholders standing in for real implementations', () => {
    expect(prompt.toLowerCase()).toContain('stub');
  });

  it('requires a draft PR, never a merge or a direct Jira write by the worker', () => {
    expect(prompt.toLowerCase()).toContain('draft pr');
  });

  it('stays under 60 lines', () => {
    expect(prompt.split('\n').length).toBeLessThan(60);
  });

  it('anchors acceptance to the exact verify command, not the agent\'s narration', () => {
    // A criterion the agent narrates is one it can assert its way past. Proven
    // exploitable against the sandbox repo: a deliberately failing test written to
    // src/retry.test.js exits 0, because the runner glob is test/**/*.test.js and it
    // was never collected. The brief must name the command and demand a collected path.
    const withCommand = buildPlannerPrompt(packet(), 'npm test');
    expect(withCommand).toMatch(/exactly this command/);
    expect(withCommand).toContain('npm test');
    expect(withCommand).toMatch(/has not run, however green/);
    expect(withCommand).toMatch(/never invent a new runner, script, or glob/);
  });

  it('never invents a grader when no verify command is configured', () => {
    // Claiming a grader that does not exist is the same failure as a self-nominated one.
    expect(buildPlannerPrompt(packet())).not.toMatch(/exactly this command/);
  });

  it('asks for a visual plan only when the change touches a screen', () => {
    expect(prompt).toMatch(/If the change touches a screen/);
    expect(prompt).toMatch(/empty test plan is noise/);
  });
});
