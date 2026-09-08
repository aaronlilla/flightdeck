/**
 * P5.7: `forge up` drives a ticket from an intake poll to a merged PR itself, with
 * nobody typing a command between hops. Every hop below is a small function taking its
 * dependencies as parameters -- `intake`, `launcher`, `gh`, `council`, `gate`, `clock`,
 * `killSwitch` -- so a specimen runs the whole chain against fakes, touching neither the
 * network nor a real process, and the production wiring (`chain-wire.ts`) is the only
 * place any of those actually reach out.
 *
 * State lives nowhere but the journal: a packet's progress is whatever `foldChainState`
 * reads back out of the `chain.*` and `intake.planned` rows already on it. A hop that
 * cannot proceed writes `chain.blocked` once, with a reason, and never retries on its
 * own -- the packet then sits there for a person, same as everything else in this file.
 */

import { haipingHandoffExample } from './contracts.ts';

export type ChainHop = 'unrouted' | 'provision' | 'launch' | 'gate';

/**
 * F1, 2026-09-05: the run key `forge run` assigns to any brief it is given -- the
 * brief file's own basename with a trailing `.md` stripped (`cli.ts`'s `run` case computes
 * the identical thing for its own `slug`). No `--name` flag exists on `forge run` and none
 * is added; the chain has to compute this the same way everywhere it names a run --
 * the launch wait, the `chain.launched` row, the finish detection in the gate hop, and the
 * status rows -- or it ends up waiting on a row that will never appear under the name it
 * guessed instead.
 */
export function runKeyForBrief(briefPath: string): string {
  return briefPath.split(/[\\/]/).pop()!.replace(/\.md$/, '');
}

/**
 * H3: the planner's brief carries no `## Verification` block of its own (`planner.ts`
 * never writes one), and `forge_done` only ever honours a `done` verdict when one is
 * there. This completes the brief once, before launch, with the repository's
 * `FORGE_REPO_VERIFY` command, the branch and base names, the ticket key, and the
 * instruction to carry the typed Haiping handoff in the PR body as a fenced JSON block.
 * A brief that already has a `## Verification` section is returned unchanged -- a second
 * H3 for the same packet (after a crash between provisioning and launch) never doubles
 * the block.
 */
export function completeBriefWithVerification(brief: string, input: {
  ticket: string; repo: string; branch: string; base: string; verifyCommand?: string;
}): string {
  if (/^##\s+Verification\b/m.test(brief)) return brief;

  const lines = [
    '',
    '## Verification',
    '',
    `Ticket: ${input.ticket}`,
    `Branch: ${input.branch} off ${input.base}, on ${input.repo}`,
    '',
    input.verifyCommand
      ? `Run this to verify:\n\n\`\`\`\n${input.verifyCommand}\n\`\`\``
      : 'No FORGE_REPO_VERIFY command is configured for this repository -- state that '
        + 'plainly in the PR body rather than guessing one.',
    '',
    'Open a draft PR whose title carries the ticket key. Once checks are green, put the',
    'typed Haiping handoff (`HaipingHandoffSchema`) in the PR body as a fenced JSON block,',
    'and name this PR\'s URL in the `forge_done` evidence. Below is that shape filled with',
    'placeholders that still validate -- copy it and replace every value, do not invent',
    'fields of your own:',
    '',
    `\`\`\`json\n${haipingHandoffExample()}\n\`\`\``,
    '',
    'deployKind is `rebuild` when this change touched android/, ios/, patches/ or a native dependency, and `ota` otherwise.',
    'notVisuallyVerified lists every step above -- no agent looks at a screen, so every step counts as not visually verified.',
    '',
    '## How this run ends',
    '',
    'Commit, push the branch, open the draft PR and call `forge_done`. Never ask whether',
    'to commit or whether to open the PR: that is this run\'s whole job. Do not write to',
    'the ticket tracker from this run, and do not stop because it is unreachable: the',
    'pipeline comments on the ticket, assigns it and links the PR once the review is',
    'done. Park only for a product or scope question the ticket itself does not answer.',
    '',
  ];
  return `${brief}\n${lines.join('\n')}`;
}

export interface ChainPlannedPacket {
  packetId: string;
  ticket: string;
  /** The routed repository (`owner/name`), or `'unknown'` when nothing in
   *  `FORGE_INTAKE_REPO_MAP` matched. */
  repo: string;
  briefPath: string;
}

export interface ChainProvisionResult {
  worktreePath: string;
  branch: string;
  /** H4: the branch's base, carried forward so the gate hop can pass it to the Codex
   *  lane as `baseRef` without re-deriving it from `chain-env.ts`. */
  base: string;
  /** D1: true when the launcher found an existing worktree on the expected branch and
   *  reused it rather than running `git worktree add` again. Carried onto the
   *  `chain.provisioned` row so `forge chain`/`forge status` can say so. */
  reused?: boolean;
}

export interface ChainLaunchResult {
  runKey: string;
}

export interface ChainRunStatus {
  finished: boolean;
  verdict?: string;
  /** The PR URL out of the run's `forge_done` evidence, when it named one. */
  prUrl?: string;
  /** The run's last handoff text, carried into `chain.blocked` when the verdict is not
   *  `done` so a person reads why without opening the run's own journal. */
  lastHandoff?: string;
  /** 2026-09-08: the goal loop's own last assistant turn, up to 160 characters,
   *  carried off the `run.finished` row a goal-mode worker journals -- so `queue.ts`'s
   *  goal branch can show "Goal met ..." or "stopped after N turns ..." without a
   *  second read of the run's own journal. Absent for every non-goal run and for a
   *  goal run whose last turn had no text. */
  lastText?: string;
}

/**
 * H2/H3: the worktree and the launch, as one dependency. Both methods are idempotent on
 * the packet id -- called again for a packet already provisioned or launched, they
 * return the same answer rather than doing the work twice. `runChainTick` never calls
 * either a second time for a packet it already has a `chain.provisioned`/`chain.launched`
 * row for, so idempotence here is a property this dependency owes its own retries, not
 * something the tick relies on.
 */
export interface ChainLauncher {
  provision(input: { packetId: string; ticket: string; repo: string }): Promise<ChainProvisionResult>;
  launch(input: {
    packetId: string; ticket: string; repo: string; briefPath: string;
    worktreePath: string; branch: string;
  }): Promise<ChainLaunchResult>;
  status(runKey: string): Promise<ChainRunStatus>;
  /** F2: whether a run under this key has actually started -- a registry row or a
   *  `run.started` journal row. `runChainTick` calls this only to reconcile a packet
   *  blocked at the launch hop; a launch that succeeds on its own never needs it. */
  runRegistered(runKey: string): Promise<boolean>;
}

export interface ChainGh {
  /** `gh pr list --repo <repo> --head <branch>`, read only when the run's own evidence
   *  named no PR URL. */
  findPrByHead(repo: string, branch: string): Promise<{ number: number; url: string } | undefined>;
}

export interface ChainCouncilResult {
  verdict: string;
  attestationPath?: string;
  /** GATE.md item 4: `forge council`'s own `coverageNote` (from its `data`), set only
   *  when the round required a member that never answered even after a retry -- e.g.
   *  "reviewed by 1 of 3 (missing: regression-risk, scope-conformance)". The queue's
   *  `advanceItem` folds this into a parked item's own `reason`, so the gap is on the
   *  board rather than only recoverable from an attestation file (which a coverage-
   *  caused FIX FIRST never even writes). */
  coverageNote?: string;
}

export type ChainCouncilFn = (input: {
  repo: string; pr: number; forceCodex: boolean;
  /** H4 (Codex lane wiring): the worker's own checkout, from the packet's provisioned
   *  row, and the repository's base branch. The Codex lane needs both before it will run
   *  at all. Omitted only for a packet whose provisioned row predates this field. */
  cwd?: string; baseRef?: string;
}) => Promise<ChainCouncilResult>;

export interface ChainGateResult {
  merged: boolean;
  mergeSha?: string;
  /** 2026-09-07: the gate's own reason lines when it did not merge -- `forge gate`'s
   *  own `lines`, so a refusal (`mergeItem`'s own message) carries the gate's actual
   *  words instead of sending a reader to dig the journal out by hand. Absent when the
   *  gate merged, or when nothing more specific than "did not merge" is on record. */
  reason?: string[];
}

export type ChainGateFn = (input: { repo: string; pr: number; merge: boolean }) => Promise<ChainGateResult>;

export interface ChainDeps {
  /** H1: the same pipeline `forge intake --once` runs (`runIntakeOnce` + a planner
   *  call per newly written packet), returning every packet planned this call. The
   *  production dependency journals `source.observed`/`packet.written`/`external.intent`
   *  itself, the same as `--once`; `runChainTick` only ever journals `intake.planned`. */
  intake(): Promise<ChainPlannedPacket[]>;
  launcher: ChainLauncher;
  gh: ChainGh;
  council: ChainCouncilFn;
  gate: ChainGateFn;
  clock(): number;
  killSwitch(): boolean;
  /** `FORGE_CHAIN_MERGE`: whether the gate may pass `--merge` for this repository. */
  mergeAllowed(repo: string): boolean;
  append(event: Record<string, unknown>): void;
}

export interface ChainPacketState {
  packetId: string;
  ticket?: string;
  repo?: string;
  briefPath?: string;
  blocked?: { hop: ChainHop; reason: string };
  /** `base` is optional here only because a journal row written before H4 landed never
   *  carried it; every row `advancePacket` writes going forward has one. */
  provisioned?: { worktreePath: string; branch: string; base?: string; reused?: boolean };
  launched?: { runKey: string };
  gated?: { verdict: string; attestationPath?: string };
  merged?: { mergeSha?: string };
  stopped?: { reason: string };
}

interface ChainEventLike {
  event?: unknown;
  actor?: unknown;
  packetId?: unknown;
  [key: string]: unknown;
}

/**
 * A packet's whole chain history, read straight off the journal's own rows. Nothing here
 * is cached anywhere else -- a fresh `forge up` process rebuilds this the same way
 * `replay()` rebuilds `FleetState`.
 */
export function foldChainState(events: ChainEventLike[]): Map<string, ChainPacketState> {
  const byPacket = new Map<string, ChainPacketState>();
  const get = (packetId: string): ChainPacketState => {
    let row = byPacket.get(packetId);
    if (!row) {
      row = { packetId };
      byPacket.set(packetId, row);
    }
    return row;
  };

  for (const raw of events) {
    const packetId = raw['packetId'];
    if (typeof packetId !== 'string' || !packetId) continue;
    const row = get(packetId);
    switch (raw.event) {
      case 'intake.planned':
        if (typeof raw['ticket'] === 'string') row.ticket = raw['ticket'];
        if (typeof raw['repo'] === 'string') row.repo = raw['repo'];
        if (typeof raw['briefPath'] === 'string') row.briefPath = raw['briefPath'];
        break;
      case 'chain.blocked':
        row.blocked = { hop: raw['hop'] as ChainHop, reason: String(raw['reason'] ?? '') };
        break;
      case 'chain.unblocked':
        // C2: `forge chain retry` -- clears the packet's blocked state so the next tick
        // is no longer terminal for it and runs the hop it stopped at again. Nothing
        // else about the row changes: a provisioned worktree stays provisioned, a
        // launched run stays launched, so re-advancing only re-does the step that
        // actually failed.
        delete row.blocked;
        // E3, 2026-09-05: `hop: 'launch'` is `forge chain retry` on a packet whose run
        // never registered -- the fold returns it to `provisioned` (rather than leaving
        // `launched` set) so the next tick re-runs the launch hop instead of polling a
        // run that was never actually started.
        if (raw['hop'] === 'launch') delete row.launched;
        break;
      case 'chain.provisioned':
        row.provisioned = {
          worktreePath: String(raw['worktreePath'] ?? ''), branch: String(raw['branch'] ?? ''),
          ...(typeof raw['base'] === 'string' ? { base: raw['base'] } : {}),
          ...(raw['reused'] === true ? { reused: true } : {}),
        };
        break;
      case 'chain.launched':
        row.launched = { runKey: String(raw['runKey'] ?? '') };
        // F2: a reconciled launch is journaled straight from a `blocked` row (the
        // launch hop's own retry never runs `chain.unblocked` first), so this clears
        // that block itself -- otherwise the row stays terminal forever with a launch
        // that in fact went ahead.
        delete row.blocked;
        break;
      case 'chain.gated':
        row.gated = {
          verdict: String(raw['verdict'] ?? ''),
          ...(typeof raw['attestationPath'] === 'string' ? { attestationPath: raw['attestationPath'] } : {}),
        };
        break;
      case 'chain.merged':
        row.merged = { ...(typeof raw['mergeSha'] === 'string' ? { mergeSha: raw['mergeSha'] } : {}) };
        break;
      case 'chain.stopped':
        row.stopped = { reason: String(raw['reason'] ?? '') };
        break;
      default:
        break;
    }
  }
  return byPacket;
}

/** Whether a packet has reached a state no further hop ever acts on again. */
function isTerminal(row: ChainPacketState): boolean {
  return Boolean(row.blocked || row.merged || row.stopped);
}

/** The tail of an error message a blocked hop keeps -- long enough to be useful, short
 *  enough that a runaway stack trace never becomes the whole reason string. */
function tailOf(message: string, limit = 500): string {
  return message.length > limit ? message.slice(-limit) : message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

async function advancePacket(row: ChainPacketState, deps: ChainDeps): Promise<void> {
  // F2: a packet blocked at the launch hop might have a run that did register -- the
  // chain lost track of it (a crash between the child registering and this process's own
  // wait resolving, say), rather than the launch itself failing. Checked before the block
  // is treated as terminal, on every tick, so this never depends on `forge chain retry` to
  // notice: a registered run folds the packet straight back to `launched`, and
  // `deps.launcher.launch` is never called a second time for it.
  if (row.blocked?.hop === 'launch' && !row.launched && row.briefPath) {
    const runKey = runKeyForBrief(row.briefPath);
    if (await deps.launcher.runRegistered(runKey)) {
      deps.append({
        event: 'chain.launched', actor: 'chain', packetId: row.packetId, runKey, reconciled: true,
      });
      return;
    }
  }

  if (isTerminal(row)) return;

  if (!row.launched) {
    if (row.repo === 'unknown') {
      deps.append({ event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'unrouted', reason: 'unrouted' });
      return;
    }
    if (!row.repo || !row.ticket || !row.briefPath) return; // not planned yet -- nothing to advance

    if (deps.killSwitch()) {
      deps.append({ event: 'chain.stopped', actor: 'chain', packetId: row.packetId, reason: 'kill-switch' });
      return;
    }

    let provisioned = row.provisioned;
    if (!provisioned) {
      try {
        const result = await deps.launcher.provision({ packetId: row.packetId, ticket: row.ticket, repo: row.repo });
        provisioned = result;
        deps.append({
          event: 'chain.provisioned', actor: 'chain', packetId: row.packetId,
          worktreePath: result.worktreePath, branch: result.branch, base: result.base,
          ...(result.reused ? { reused: true } : {}),
        });
      } catch (error) {
        deps.append({
          event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'provision',
          reason: tailOf(messageOf(error)),
        });
        return;
      }
    }

    try {
      const launched = await deps.launcher.launch({
        packetId: row.packetId, ticket: row.ticket, repo: row.repo, briefPath: row.briefPath,
        worktreePath: provisioned.worktreePath, branch: provisioned.branch,
      });
      deps.append({
        event: 'chain.launched', actor: 'chain', packetId: row.packetId, runKey: launched.runKey,
        worktreePath: provisioned.worktreePath, branch: provisioned.branch,
      });
    } catch (error) {
      deps.append({
        event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'launch',
        reason: tailOf(messageOf(error)),
      });
    }
    return;
  }

  // H4: the run is launched. Nothing to do until it finishes.
  if (row.gated) return; // already gated this run; merged/stopped would have been terminal above
  const status = await deps.launcher.status(row.launched.runKey);
  if (!status.finished) return;

  if (status.verdict !== 'done') {
    deps.append({
      event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'gate',
      reason: status.verdict ?? 'unknown', ...(status.lastHandoff ? { lastHandoff: status.lastHandoff } : {}),
    });
    return;
  }

  if (deps.killSwitch()) {
    deps.append({ event: 'chain.stopped', actor: 'chain', packetId: row.packetId, reason: 'kill-switch' });
    return;
  }

  let pr: { number: number; url: string } | undefined = status.prUrl
    ? (() => {
        const number = prNumberFromUrl(status.prUrl!);
        return number !== undefined ? { number, url: status.prUrl! } : undefined;
      })()
    : undefined;
  if (!pr && row.provisioned) pr = await deps.gh.findPrByHead(row.repo!, row.provisioned.branch);
  if (!pr) {
    deps.append({
      event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'gate',
      reason: 'run finished done but no PR was found in its evidence or on its branch',
    });
    return;
  }

  const council = await deps.council({
    repo: row.repo!, pr: pr.number, forceCodex: true,
    cwd: row.provisioned?.worktreePath,
    // The remote ref, for the reason `queue.ts` gives at its own council call.
    baseRef: row.provisioned?.base ? `origin/${row.provisioned.base}` : undefined,
  });
  deps.append({
    event: 'chain.gated', actor: 'chain', packetId: row.packetId, verdict: council.verdict,
    ...(council.attestationPath ? { attestationPath: council.attestationPath } : {}),
  });

  const councilCleared = council.verdict === 'PASS' || council.verdict === 'PASS WITH NOTES';
  if (!councilCleared) {
    deps.append({
      event: 'chain.blocked', actor: 'chain', packetId: row.packetId, hop: 'gate', reason: council.verdict,
    });
    return;
  }

  const merge = deps.mergeAllowed(row.repo!);
  const gateResult = await deps.gate({ repo: row.repo!, pr: pr.number, merge });
  if (merge && gateResult.merged) {
    deps.append({
      event: 'chain.merged', actor: 'chain', packetId: row.packetId,
      ...(gateResult.mergeSha ? { mergeSha: gateResult.mergeSha } : {}),
    });
  } else {
    deps.append({ event: 'chain.stopped', actor: 'chain', packetId: row.packetId, reason: 'draft-pr' });
  }
}

export interface ChainTickResult {
  packets: number;
}

/**
 * One tick of the chain: H1 for every newly planned packet, then H2 through H4 for
 * every packet this or an earlier tick already knows about. `state` is the fold of the
 * journal so far; callers own replaying it (production replays the real journal, a
 * specimen builds one from the events it appended).
 */
export async function runChainTick(deps: ChainDeps, state: Map<string, ChainPacketState>): Promise<ChainTickResult> {
  if (!deps.killSwitch()) {
    const planned = await deps.intake();
    for (const packet of planned) {
      if (state.has(packet.packetId)) continue;
      deps.append({
        event: 'intake.planned', actor: 'intake', packetId: packet.packetId, ticket: packet.ticket,
        repo: packet.repo, briefPath: packet.briefPath,
      });
      state.set(packet.packetId, {
        packetId: packet.packetId, ticket: packet.ticket, repo: packet.repo, briefPath: packet.briefPath,
      });
    }
  }

  for (const row of [...state.values()]) {
    await advancePacket(row, deps);
  }

  return { packets: state.size };
}

/** `forge status`/`/state`: one row per packet, in the shape both surfaces print. */
export interface ChainStatusRow {
  ticket: string;
  packetId: string;
  hop: string;
  state: string;
  reason?: string;
  /** F1: the run key `forge run` is actually using for this packet -- present once the
   *  launch hop has produced one, so a person reading `forge status`/`forge chain` can
   *  match a row here to the run it names, rather than guessing at it from the ticket. */
  runKey?: string;
}

function hopAndStateOf(row: ChainPacketState): { hop: string; state: string; reason?: string } {
  if (row.merged) return { hop: 'gate', state: 'merged' };
  if (row.stopped) return { hop: 'gate', state: `stopped (${row.stopped.reason})` };
  if (row.blocked) return { hop: row.blocked.hop, state: 'blocked', reason: row.blocked.reason };
  if (row.gated) return { hop: 'gate', state: `gated (${row.gated.verdict})` };
  if (row.launched) return { hop: 'gate', state: 'waiting on the run' };
  if (row.provisioned) return { hop: 'launch', state: 'provisioned' };
  return { hop: 'provision', state: 'planned' };
}

export function chainStatusRows(state: Map<string, ChainPacketState>): ChainStatusRow[] {
  return [...state.values()].map((row) => {
    const { hop, state: rowState, reason } = hopAndStateOf(row);
    return {
      ticket: row.ticket ?? row.packetId, packetId: row.packetId, hop, state: rowState,
      ...(reason ? { reason } : {}),
      ...(row.launched?.runKey ? { runKey: row.launched.runKey } : {}),
    };
  });
}

export function chainStatusLines(state: Map<string, ChainPacketState>): string[] {
  return chainStatusRows(state).map((row) => `chain ${row.ticket} [${row.hop}] ${row.state}${row.runKey ? ` (run ${row.runKey})` : ''}${row.reason ? `: ${row.reason}` : ''}`);
}
