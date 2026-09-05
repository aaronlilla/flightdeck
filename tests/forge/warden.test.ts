/**
 * `WardenActuator`: the one thing allowed to act on a run, over the transports B.3 built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Journal } from '../../src/forge/journal.js';
import { readParkRecord } from '../../src/forge/parkrecord.js';
import { Registry } from '../../src/forge/registry.js';
import { RunInbox } from '../../src/forge/runinbox.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { findDecision, WardenActuator } from '../../src/forge/warden.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { readFileSync } from 'node:fs';

let home: string;
let journalPath: string;
let journal: Journal;
let registry: Registry;
let lanes: Lanes;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-warden-'));
  process.env['FORGE_HOME'] = home;
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
  registry = new Registry(join(home, 'registry'));
  lanes = new Lanes(join(home, 'lanes'));
});

afterEach(() => {
  journal.close();
  delete process.env['FORGE_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('park', () => {
  it('writes a park record the run reads back, not only a journal row', async () => {
    const actuator = new WardenActuator({ journal, journalPath, registry, lanes });
    await actuator.park('r1', 'idle for 300s');
    expect(readParkRecord('r1')?.reason).toBe('idle for 300s');
  });
});

describe('nudge and resume', () => {
  it('nudge queues a message into the run inbox without touching the park record', async () => {
    const actuator = new WardenActuator({ journal, journalPath, registry, lanes });
    await actuator.nudge('r1', 'heads up: base moved');
    const messages = new RunInbox('r1').all();
    expect(messages.map((m) => m.text)).toContain('heads up: base moved');
    expect(readParkRecord('r1')).toBeUndefined();
  });

  it('resume clears the park record and delivers the input', async () => {
    const actuator = new WardenActuator({ journal, journalPath, registry, lanes });
    await actuator.park('r1', 'idle');
    await actuator.resume('r1', 'go ahead');
    expect(readParkRecord('r1')).toBeUndefined();
    const messages = new RunInbox('r1').all();
    expect(messages.map((m) => m.text)).toContain('go ahead');
  });
});

describe('kill without a decision id', () => {
  it('is rejected: the process is left alone and the refusal is journaled', async () => {
    let killed = false;
    registry.admit({ goal: 'r1', cwd: 'C:/nowhere', briefPath: 'C:/nowhere/brief.md', pid: 999999 });
    const actuator = new WardenActuator({
      journal, journalPath, registry, lanes, killProcess: () => { killed = true; },
    });

    await actuator.kill('r1', 'made-up-id');

    expect(killed).toBe(false);
    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events.some((e) => e.event === 'warden.refused' && e.run === 'r1')).toBe(true);
  });
});

describe('kill with a valid decision', () => {
  it('kills the registered pid once, journals the evidence and the decision id', async () => {
    registry.admit({ goal: 'r1', cwd: 'C:/nowhere', briefPath: 'C:/nowhere/brief.md', pid: 424242 });
    const decision = journal.append({
      event: 'decision.made', run: 'r1', actor: 'aaron', action: 'kill', reason: 'stuck for an hour',
    });

    const killedPids: number[] = [];
    const actuator = new WardenActuator({
      journal, journalPath, registry, lanes, killProcess: (pid) => { killedPids.push(pid); },
    });

    await actuator.kill('r1', decision.id);

    expect(killedPids).toEqual([424242]);
    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    const killedEvent = events.find((e) => e.event === 'run.killed');
    expect(killedEvent?.decisionId).toBe(decision.id);
    expect(killedEvent?.evidence).toEqual([decision.id]);
  });

  it('a decisionId naming a different run is refused', async () => {
    registry.admit({ goal: 'r1', cwd: 'C:/nowhere', briefPath: 'C:/nowhere/brief.md', pid: 111111 });
    const decision = journal.append({
      event: 'decision.made', run: 'r2', actor: 'aaron', action: 'kill', reason: 'wrong run',
    });
    const killedPids: number[] = [];
    const actuator = new WardenActuator({
      journal, journalPath, registry, lanes, killProcess: (pid) => { killedPids.push(pid); },
    });

    await actuator.kill('r1', decision.id);

    expect(killedPids).toEqual([]);
  });
});

describe('findDecision', () => {
  it('returns undefined when the journal file does not exist yet', () => {
    expect(findDecision(join(home, 'nope.jsonl'), 'r1', 'kill', 'x')).toBeUndefined();
  });
});
