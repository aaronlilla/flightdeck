/**
 * `forge intake --once`'s planner: one queued packet through the `Reasoner`, producing a
 * goal brief's text. This module never launches anything and never writes a file itself
 * -- `cli.ts` owns where a brief lands, the same separation `council/attest.ts` keeps
 * from Council's own orchestration. Provider selection is `resolvePlanProvider`'s job
 * (decision 6): always `claude`.
 */
import type { Packet, Reasoner } from '../contracts.ts';
import { ensureTierLine, type TierDecision } from './tier.ts';

export interface PlannedBrief {
  packetId: string;
  ticket: string;
  text: string;
  tier: TierDecision;
}

export function buildPlannerPrompt(packet: Packet, verifyCommand?: string): string {
  return [
    'You are Forge Intake\'s planner. One findings packet is queued below. Propose a',
    'goal brief for it: what to fix, its acceptance, nothing that launches anything.',
    '',
    'Packet:',
    JSON.stringify(packet),
    '',
    'The brief you write becomes instructions for a worker agent with no device and no',
    'eyes, so every rule below is fixed, not a suggestion. Verification splits two ways:',
    'the worker verifies whatever a test can reach, and Haiping Chen (QA) verifies',
    'whatever a human eye has to see. Never ask the worker to run on a device or an',
    'emulator, take a screenshot, or confirm something looks right, and never list a',
    'screenshot or a visual check as acceptance or as evidence -- there is no device or',
    'emulator to run one on. Tests are behaviour tests only: @testing-library/react-native',
    'for components, plain unit tests for hooks and pure functions, integration tests at',
    'the API error-contract seam. Never ask for a snapshot test. State every acceptance',
    'criterion so it is observable straight from a tool call in the worker\'s transcript --',
    'a named test file, a file path, an exact string, a status code -- and never phrase one',
    'as "renders cleanly" or "looks right". You cannot read the repository yourself, so',
    'tell the worker to scout the code first and cite file:line for what it found in its',
    'first status update; if the packet above carries a file path or line hint, repeat it',
    'in the brief rather than describing the screen by name. Demand a full, working',
    'implementation -- no stub, mock, placeholder, or hardcoded literal standing in for the',
    'real path. If the change touches a screen, the PR body must carry Haiping\'s visual',
    'test plan: every screen the diff touches, what he should see there, and the sentence',
    'that no agent visually verified it. If it touches no screen -- a pure function, a',
    'utility, a backend path -- say so in one line and write no visual plan at all; an',
    'empty test plan is noise that trains a reviewer to skip the section. While iterating, run only the test files the change touches; run the full suite',
    'once at the end. The worker opens a draft PR only -- it never merges, and it never',
    'writes to Jira; that is the pipeline\'s job once the PR lands.',
    ...(verifyCommand
      ? [
        '',
        // A criterion the agent narrates is a criterion the agent can assert its way
        // past. The harness decides `done` by running exactly one command, so the brief
        // must anchor acceptance to that command and to paths it actually collects --
        // otherwise a green-looking test can sit at a path the runner never globs, and
        // the transcript still reads clean.
        'The pipeline decides this run passed by executing exactly this command, and',
        'nothing else:',
        '',
        '```',
        verifyCommand,
        '```',
        '',
        'State acceptance in terms of that command\'s exit status. Put every new test',
        'where that command already collects it -- read the existing test paths and',
        'match them; a test the command does not collect has not run, however green the',
        'transcript looks. Name the exact test file path you chose in the brief, and',
        'never invent a new runner, script, or glob.',
      ]
      : []),
    '',
    'Set your `text` field to the full brief as Markdown, starting with a "# Goal:"',
    'heading.',
    '',
    'Immediately under that heading, decide this ticket\'s complexity tier -- the',
    'pipeline runs the worker on a cheaper or pricier model depending on what you say',
    'here, so read the rubric and commit to one:',
    '  "light"    -- a copy, text, config, or single-file change with an obvious test,',
    '                 touching no money, auth, payments, wallet, ledger, or migration.',
    '  "hard"     -- spans multiple repos; touches money, a ledger, a wallet, a payment',
    '                 or auth/security surface; involves concurrency; needs a migration;',
    '                 or the root cause is not yet clear.',
    '  "standard" -- everything else. When in doubt, say standard.',
    'Write `tier: light`, `tier: standard` or `tier: hard` on its own line, then',
    '`tier-reason: ` and one short sentence for why, on the next line.',
  ].join('\n');
}

/**
 * One queued packet through the Reasoner. Never writes a file itself.
 *
 * `className` defaults to `'plan'`, unchanged from before this parameter existed. C.2:
 * a pasted brief or a typed hotfix has no ticket to triangulate, so planning it does not
 * need `plan`'s full budget -- the queue's own planner (`queue-wire.ts`'s `queuePlanner`,
 * stream A's file) is where a `brief`/`hotfix` source decides to pass `'triage'` instead;
 * this function only has to accept the choice, never make it.
 */
export async function planFromPacket(
  packet: Packet, reasoner: Reasoner, className = 'plan', verifyCommand?: string,
): Promise<PlannedBrief> {
  const prompt = buildPlannerPrompt(packet, verifyCommand);
  const result = await reasoner.call({ className, prompt, replyShape: 'text' });
  // Complexity routing is on by default -- no env flag, no config switch. Every brief
  // this function hands back already carries a `tier:` line, whatever the model said
  // (or didn't say): `ensureTierLine` defaults a missing or invalid tier to `standard`
  // and never lets a money/auth ticket ride on `light`.
  const { text, decision } = ensureTierLine(result.text);
  return { packetId: packet.id, ticket: packet.ticket, text, tier: decision };
}
