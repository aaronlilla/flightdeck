/**
 * Every rule in `buildPreToolUseHook`, walked from the real rule list.
 *
 * Three things, each over `buildPreToolUseRules` itself rather than a copied list, so a rule
 * added later without a specimen here fails instead of going unexercised:
 * - a refusal leaves the session free to carry on to `forge_done`; only the kill switch and
 *   the context ceiling end the turn, because the run loop answers those itself;
 * - every refused call is still refused, with the same reason and journal row it had on
 *   main before this change (literal strings below, never read back off the rule);
 * - the launch prompt names every tool refused by name.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildOptions } from '../../src/adapter/engine.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { clearParkRecord, writeParkRecord } from '../../src/forge/parkrecord.js';
import {
  buildPreToolUseHook, buildPreToolUseRules, buildWorkerOptions, SdkEngine, type PreToolUseHookDeps,
} from '../../src/forge/sdkengine.js';
import { HANDOFF_REQUEST, STOP_HANDOFF_REQUEST } from '../../src/forge/worker.js';
import { onePrompt, sdkLikeQuery, type ToolStep } from './sdk-like-query.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  journalPath = join(home, 'fleet.jsonl');
  process.env['FORGE_HOME'] = home;
});

const RUN = 'rules-run';
const FORGE_DONE = 'mcp__forge__forge_done';

interface Specimen {
  /** Deps this rule needs to fire, on top of the plain run. */
  deps?: (base: PreToolUseHookDeps) => Partial<PreToolUseHookDeps>;
  arm?: (deps: PreToolUseHookDeps) => void;
  /** Lifts a sticky refusal (a park) once it has been seen, so forge_done can run. */
  lift?: (deps: PreToolUseHookDeps) => void;
  call: { name: string; input: Record<string, unknown> };
  endsTurn: boolean;
  /** The verdict main gave before this change, literally. */
  reason: string | RegExp;
  additionalContext?: string;
  journal: { event: string; reason?: string };
}

const MONITOR_REASON = 'Monitor is refused inside a worker run: it has ended a session mid-turn before, and there is '
  + 'no console here to receive its notifications. Poll with a plain Bash command instead.';
const TASKOUTPUT_REASON = 'Do not poll a background task with block: false inside a worker run: each poll costs a turn. '
  + 'Call TaskOutput with block: true and a timeout, and continue from its result.';

const SPECIMENS: Record<string, Specimen> = {
  'warden-park': {
    arm: () => writeParkRecord(RUN, { key: 'warden-1', reason: 'off brief', at: 1 }),
    lift: () => clearParkRecord(RUN),
    call: { name: 'Bash', input: { command: 'echo hi' } },
    endsTurn: false,
    reason: 'parked by warden: off brief',
    journal: { event: 'permission.denied', reason: 'parked by warden: warden-1' },
  },
  'ask-park': {
    arm: (deps) => deps.parked.set(RUN, 'ask-1'),
    lift: (deps) => deps.parked.delete(RUN),
    call: { name: 'Bash', input: { command: 'echo hi' } },
    endsTurn: false,
    reason: 'parked on ask-1: this run takes no further tool call until that question is answered',
    journal: { event: 'permission.denied', reason: 'parked on ask-1' },
  },
  'refuse-Monitor': {
    call: { name: 'Monitor', input: { command: 'gh pr checks 12', persistent: true } },
    endsTurn: false,
    reason: MONITOR_REASON,
    journal: {
      event: 'permission.denied',
      reason: 'a worker session has no console to watch Monitor notifications on, and a Monitor call has '
        + 'ended a live worker session mid-turn without finishing; poll status yourself with Bash instead',
    },
  },
  'refuse-TaskOutput': {
    call: { name: 'TaskOutput', input: { task_id: 'b1', block: false } },
    endsTurn: false,
    reason: TASKOUTPUT_REASON,
    journal: {
      event: 'permission.denied',
      reason: 'a non-blocking TaskOutput poll costs a turn each time; block on the task instead',
    },
  },
  'kill-switch': {
    deps: () => ({ killSwitchHit: () => true }),
    call: { name: 'Bash', input: { command: 'echo hi' } },
    endsTurn: true,
    reason: 'forge stop --all engaged the kill switch: write the handoff packet instead of another tool call',
    additionalContext: STOP_HANDOFF_REQUEST,
    journal: { event: 'permission.denied', reason: 'the fleet kill switch is engaged' },
  },
  'context-ceiling': {
    deps: () => ({ ceilingHit: () => true }),
    call: { name: 'Bash', input: { command: 'echo hi' } },
    endsTurn: true,
    reason: 'context ceiling reached: write the handoff packet instead of another tool call',
    additionalContext: HANDOFF_REQUEST,
    journal: { event: 'permission.denied', reason: 'context ceiling reached' },
  },
  'council-rules': {
    deps: () => ({ repoContext: { branch: 'main', controlled: true } }),
    call: { name: 'Bash', input: { command: 'git push origin main' } },
    endsTurn: false,
    reason: /^gitflow: .*controlled-code repo/i,
    journal: { event: 'rule.denied' },
  },
};

function depsFor(specimen: Specimen | undefined, journal: Journal): PreToolUseHookDeps {
  const base: PreToolUseHookDeps = {
    run: RUN, goal: RUN, journal, parked: new Map(), inbox: new Inbox(join(home, 'inbox')), deliverVia: 'stream',
  };
  const deps = { ...base, ...(specimen?.deps?.(base) ?? {}) };
  specimen?.arm?.(deps);
  return deps;
}

const RULE_NAMES = (() => {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-rule-names-'));
  const journal = new Journal(join(scratch, 'j.jsonl'));
  const names = buildPreToolUseRules({
    run: 'names', goal: 'names', journal, parked: new Map(), inbox: new Inbox(join(scratch, 'inbox')),
    deliverVia: 'stream',
  }).map((rule) => rule.name);
  journal.close();
  return names;
})();

describe('the rule list itself', () => {
  it('has a specimen here for every rule buildPreToolUseHook runs', () => {
    expect(RULE_NAMES.length).toBeGreaterThan(0);
    expect(RULE_NAMES.filter((name) => !SPECIMENS[name])).toEqual([]);
  });
});

describe.each(RULE_NAMES)('rule %s', (name) => {
  it('still refuses the call, with the reason and journal row it had before', async () => {
    const specimen = SPECIMENS[name]!;
    const journal = new Journal(journalPath);
    const hook = buildPreToolUseHook(depsFor(specimen, journal));

    const verdict = await hook({ toolName: specimen.call.name, input: specimen.call.input, toolUseId: 'tu-1' });

    expect(verdict.decision).toBe('deny');
    if (typeof specimen.reason === 'string') expect(verdict.reason).toBe(specimen.reason);
    else expect(verdict.reason).toMatch(specimen.reason);
    expect(verdict.additionalContext).toBe(specimen.additionalContext);
    journal.close();
    const row = replay(journalPath).events.find((e) => e.run === RUN && e.event === specimen.journal.event);
    expect(row?.['tool']).toBe(specimen.call.name);
    if (specimen.journal.reason !== undefined) expect(row?.['reason']).toBe(specimen.journal.reason);
  });

  it(SPECIMENS[name]?.endsTurn
    ? 'ends the turn, because the run loop answers this stop with its own handoff request'
    : 'leaves the session free to carry on to forge_done after the refusal', async () => {
    const specimen = SPECIMENS[name]!;
    const journal = new Journal(journalPath);
    const deps = depsFor(specimen, journal);
    const steps: ToolStep[] = [
      { name: specimen.call.name, input: specimen.call.input, after: () => specimen.lift?.(deps) },
      { name: FORGE_DONE, input: { evidence: 'done' } },
    ];
    const fake = sdkLikeQuery([steps]);
    const options = buildOptions({
      cwd: home, canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
      onToolCall: buildPreToolUseHook(deps),
    });

    for await (const _message of fake.fn({ prompt: onePrompt('go') as never, options })) { /* drain */ }
    journal.close();

    expect(fake.refusals).toHaveLength(1);
    // The model's next step sees the refusal's own reason as the tool result.
    expect(fake.toolResults[0]).toBe(fake.refusals[0]!.slice(specimen.call.name.length + 2));
    if (specimen.endsTurn) expect(fake.ran).toEqual([]);
    else expect(fake.ran).toEqual([FORGE_DONE]);
  });
});

async function drive(deps: PreToolUseHookDeps, steps: ToolStep[]) {
  const fake = sdkLikeQuery([steps]);
  const options = buildOptions({
    cwd: home, canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    onToolCall: buildPreToolUseHook(deps),
  });
  for await (const _message of fake.fn({ prompt: onePrompt('go') as never, options })) { /* drain */ }
  return fake;
}

const BASH = { name: 'Bash', input: { command: 'echo hi' } };

describe('a run that stays parked cannot loop on refusals', () => {
  it.each(['warden-park', 'ask-park'])('%s: the first refusal carries on, a second in a row ends the turn', async (name) => {
    const journal = new Journal(journalPath);
    const deps = depsFor(SPECIMENS[name], journal);

    const fake = await drive(deps, [BASH, BASH, BASH, { name: FORGE_DONE, input: { evidence: 'done' } }]);
    journal.close();

    expect(fake.refusals).toHaveLength(2);
    expect(fake.ran).toEqual([]);
  });

  it('the count starts over once a call gets past the park', async () => {
    const journal = new Journal(journalPath);
    const deps = depsFor(SPECIMENS['ask-park'], journal);

    const fake = await drive(deps, [
      { ...BASH, after: () => deps.parked.delete(RUN) },
      { name: 'Read', input: { file_path: 'README.md' }, after: () => deps.parked.set(RUN, 'ask-2') },
      BASH,
      { name: FORGE_DONE, input: { evidence: 'done' }, after: () => deps.parked.delete(RUN) },
    ]);
    journal.close();

    // Refused, passed, refused (a first refusal again, so the turn goes on), then refused
    // again as the second in a row: forge_done never runs while still parked.
    expect(fake.refusals).toHaveLength(3);
    expect(fake.ran).toEqual(['Read']);
  });
});

describe('no refusal that carries on can keep a run away from the two stops', () => {
  it('an ask-parked run past its context ceiling keeps its park reason and ends the turn', async () => {
    const journal = new Journal(journalPath);
    const deps = { ...depsFor(SPECIMENS['ask-park'], journal), ceilingHit: () => true };

    const verdict = await buildPreToolUseHook(deps)({ toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 't' });
    journal.close();

    expect(verdict.endTurn).toBe(true);
    expect(verdict.reason).toMatch(/^parked on ask-1/);
  });

  it('a warden-parked run under the kill switch keeps its park reason and ends the turn', async () => {
    const journal = new Journal(journalPath);
    const deps = { ...depsFor(SPECIMENS['warden-park'], journal), killSwitchHit: () => true };

    const verdict = await buildPreToolUseHook(deps)({ toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 't' });
    journal.close();
    clearParkRecord(RUN);

    expect(verdict.endTurn).toBe(true);
    expect(verdict.reason).toMatch(/^parked by warden/);
  });

  it('a Monitor call under the kill switch ends the turn on the kill switch', async () => {
    const journal = new Journal(journalPath);
    const deps = { ...depsFor(undefined, journal), killSwitchHit: () => true };

    const verdict = await buildPreToolUseHook(deps)({ toolName: 'Monitor', input: { command: 'x' }, toolUseId: 't' });
    journal.close();

    expect(verdict.endTurn).toBe(true);
  });
});

describe('the launch prompt names every tool refused by name', () => {
  const REQUEST = { model: 'claude-sonnet-5', prompt: '# Goal\n\nDo the thing.\n', cwd: home, env: {} };
  const refusedTools = () => {
    const journal = new Journal(journalPath);
    const tools = buildPreToolUseRules(depsFor(undefined, journal)).flatMap((rule) => (rule.tool ? [rule.tool] : []));
    journal.close();
    return tools;
  };

  it('buildWorkerOptions puts each refused tool name in the prompt, verbatim', () => {
    const tools = refusedTools();
    expect(tools).toEqual(expect.arrayContaining(['Monitor', 'TaskOutput']));
    const prompt = buildWorkerOptions({ ...REQUEST, cwd: home }).prompt;
    expect(prompt.startsWith(REQUEST.prompt)).toBe(true);
    for (const tool of tools) expect(prompt).toContain(`\`${tool}\``);
  });

  it('leaves a /goal prompt exactly as written, since appended text would join the goal condition', () => {
    const goal = '/goal Work C:/dev/.claude/goals/x.md to completion. Met only when the PR is open.';
    expect(buildWorkerOptions({ ...REQUEST, prompt: goal, cwd: home }).prompt).toBe(goal);
  });

  it('the prompt a real run sends first carries the same list', async () => {
    const fake = sdkLikeQuery([[{ name: FORGE_DONE, input: { evidence: 'done' } }]]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox'), gotchasDir: join(home, 'gotchas'), queryFn: fake.fn,
    });
    await engine.run({ run: RUN, model: 'claude-sonnet-5', prompt: REQUEST.prompt, cwd: home, env: {} });

    expect(fake.prompts[0]?.startsWith(REQUEST.prompt)).toBe(true);
    for (const tool of refusedTools()) expect(fake.prompts[0]).toContain(`\`${tool}\``);
  });
});
