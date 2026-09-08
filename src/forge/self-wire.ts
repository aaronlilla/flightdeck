/**
 * `forge up`'s own wiring for the self loop (`src/forge/self/*`): on a cadence, read what
 * the fleet recorded about itself, turn findings into queue items against the self repo,
 * merge a self item whose gate cleared, and ask for a restart once trunk has moved and
 * nothing is in flight. Everything here is glue over real files and real commands; the
 * decisions live in the pure modules this file calls, each with its own specimens.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ChainEnv } from './chain-env.js';
import { checkoutFor } from './chain-env.js';
import type { CouncilAttestation } from './contracts.js';
import { REAL_GH } from './council/gh.js';
import { run as execRun } from './exec.js';
import { Gotchas } from './gotcha.js';
import type { QueueMergeDeps } from './intake/queue.js';
import { queueBusy, QUEUE_IN_FLIGHT_STATES } from './intake/queue.js';
import type { QueueStore } from './intake/queueStore.js';
import { Journal, JournalCache } from './journal.js';

const journalCache = new JournalCache();
import { forgeHome, gotchasDir, journalPath } from './paths.js';
import { analyze, type AttestationRoundInput, type RunTranscript, type SelfAnalyzeInputs } from './self/analyze.js';
import { enqueueFindings } from './self/enqueue.js';
import { FindingsLedger } from './self/ledger.js';
import { cutoverDue } from './self/selfCutover.js';
import { isRuntimePathChange, runSelfMerge } from './self/selfMerge.js';
import { selfStatus, type SelfStatus } from './self/status.js';

export interface SelfLoopOptions {
  chainEnv: ChainEnv;
  store: QueueStore;
  mergeDeps: QueueMergeDeps;
  /** The head this process is running; a cutover is due once trunk differs from it. */
  runningHead: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams. Defaults are the real files under the forge home and real git/gh. */
  home?: string;
  clock?: () => number;
  gather?: () => SelfAnalyzeInputs;
  git?: Parameters<typeof cutoverDue>[0]['git'];
  prChecks?: (repo: string, pr: number) => Promise<'success' | 'failure' | 'pending' | undefined>;
}

export interface SelfTickResult {
  enabled: boolean;
  findings: number;
  enqueued: number;
  merged: string[];
  refused: string[];
  restart: boolean;
}

export interface SelfLoop {
  enabled: boolean;
  selfRepo: string;
  tick(): Promise<SelfTickResult>;
  status(): SelfStatus | undefined;
}

/** Every attestation on disk, reduced to what the analyzer scores: which members each
 *  round was missing. Reads the tree under `<home>/attestations/<owner>/<repo>/<pr>/`. */
export function readAttestationRounds(home: string): AttestationRoundInput[] {
  const root = join(home, 'attestations');
  if (!existsSync(root)) return [];
  const rounds: AttestationRoundInput[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CouncilAttestation>;
        if (typeof parsed.repo !== 'string' || typeof parsed.pr !== 'number') continue;
        rounds.push({
          repo: parsed.repo, pr: parsed.pr, round: parsed.round ?? 1,
          missing: parsed.coverage?.missing ?? [],
        });
      } catch {
        // An unreadable attestation is not evidence of anything; skip it.
      }
    }
  };
  walk(root);
  return rounds;
}

/** One transcript per run from the journal: the tool names in order, the gotchas it
 *  filed and the reasons it parked. Only tool names are journaled today, so this is the
 *  grain the repeated-work detector works at. */
export function transcriptsFromJournal(events: Array<Record<string, unknown>>): RunTranscript[] {
  const byRun = new Map<string, RunTranscript>();
  const forRun = (run: string): RunTranscript => {
    let entry = byRun.get(run);
    if (!entry) {
      entry = { run, toolSequence: [], gotchaIds: [], parkReasons: [] };
      byRun.set(run, entry);
    }
    return entry;
  };
  for (const event of events) {
    const run = typeof event['run'] === 'string' ? event['run'] : undefined;
    if (!run) continue;
    const name = event['event'];
    if (name === 'tool.start' && typeof event['tool'] === 'string') forRun(run).toolSequence.push(event['tool']);
    else if (name === 'gotcha.recorded' && typeof event['gotchaId'] === 'string') forRun(run).gotchaIds.push(event['gotchaId']);
    else if (name === 'run.parked' && typeof event['reason'] === 'string') forRun(run).parkReasons.push(event['reason']);
    if (typeof event['ticket'] === 'string' && byRun.has(run)) forRun(run).ticket = event['ticket'];
  }
  return [...byRun.values()];
}

function realGit(): NonNullable<SelfLoopOptions['git']> {
  const git = async (checkout: string, argv: string[]): Promise<string> => {
    const result = await execRun({ argv: ['git', ...argv], cwd: checkout, owner: 'self', cls: 'script', raw: true, fullOutput: true, wall: 60_000 });
    if (!result.ok) throw new Error(`git ${argv[0]} failed: ${(result.full ?? result.tail).trim().slice(0, 200)}`);
    return (result.full ?? result.tail).trim();
  };
  return {
    fetch: async (checkout) => { await git(checkout, ['fetch', '--quiet', 'origin']); },
    remoteHead: (checkout, ref) => git(checkout, ['rev-parse', `origin/${ref}`]),
    pullFastForward: async (checkout) => { await git(checkout, ['pull', '--ff-only', '--quiet']); },
  };
}

export function buildSelfLoop(opts: SelfLoopOptions): SelfLoop {
  const env = opts.env ?? process.env;
  const selfRepo = (env['FORGE_SELF_REPO'] ?? '').trim();
  const home = opts.home ?? forgeHome();
  const clock = opts.clock ?? (() => Date.now());
  const enabled = selfRepo.length > 0;
  const ledger = new FindingsLedger(join(home, 'self', 'findings.jsonl'));
  const checkout = checkoutFor(opts.chainEnv, selfRepo);

  const append = (event: Record<string, unknown>): { id: string } => {
    const journal = new Journal(journalPath());
    try {
      return journal.append(event as never);
    } finally {
      journal.close();
    }
  };

  const gather = opts.gather ?? ((): SelfAnalyzeInputs => {
    const state = journalCache.read(journalPath());
    const events = state.events as unknown as Array<Record<string, unknown>>;
    return {
      gotchas: new Gotchas(gotchasDir(), journalPath()).all(),
      events: state.events,
      runs: Object.values(state.runs),
      attestationRounds: readAttestationRounds(home),
      runTranscripts: transcriptsFromJournal(events),
      now: clock(),
    };
  });

  const prChecks = opts.prChecks ?? (async (repo: string, pr: number) => {
    try {
      return (await REAL_GH.viewPr(repo, pr)).checks.conclusion;
    } catch {
      return undefined;
    }
  });

  const idle = (): boolean =>
    !queueBusy() && !opts.store.all().some((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state));

  async function mergeSelfItems(): Promise<{ merged: string[]; refused: string[] }> {
    const merged: string[] = [];
    const refused: string[] = [];
    const candidates = opts.store.all().filter((item) => item.state === 'review' && item.repo === selfRepo && item.pr);
    for (const item of candidates) {
      const attestation = latestAttestation(home, selfRepo, item.pr!.no);
      const conclusion = await prChecks(selfRepo, item.pr!.no);
      const changedFiles = item.changedFiles ?? [];
      const probeOk = isRuntimePathChange(changedFiles) ? readProbeResult(home, attestation?.head) : undefined;
      const result = await runSelfMerge(item, {
        repo: item.repo ?? '', selfRepo,
        selfMergeEnabled: env['FORGE_SELF_MERGE'] === '1',
        attestation: attestation ? { verdict: attestation.verdict, coverage: attestation.coverage } : undefined,
        checks: conclusion ? { conclusion } : undefined,
        changedFiles, probeOk,
      }, opts.mergeDeps, append);
      (result.ok ? merged : refused).push(item.id);
    }
    return { merged, refused };
  }

  return {
    enabled,
    selfRepo,
    async tick(): Promise<SelfTickResult> {
      if (!enabled) return { enabled, findings: 0, enqueued: 0, merged: [], refused: [], restart: false };
      const findings = analyze(gather());
      const enqueued = enqueueFindings(findings, {
        store: opts.store, briefsDir: join(home, 'self', 'briefs'), ledger, selfRepo,
        maxInFlight: Number(env['FORGE_SELF_MAX_IN_FLIGHT'] ?? 1) || 1, clock, append,
      });
      const { merged, refused } = await mergeSelfItems();
      let restart = false;
      if (checkout && env['FORGE_SELF_CUTOVER'] !== '0') {
        const due = await cutoverDue({
          checkout, runningHead: opts.runningHead, idle, git: opts.git ?? realGit(), append,
          ref: env['FORGE_SELF_REF'] ?? 'main',
        });
        restart = due.restart;
      }
      return { enabled, findings: findings.length, enqueued: enqueued.length, merged, refused, restart };
    },
    status(): SelfStatus | undefined {
      return enabled ? selfStatus(ledger, opts.store, selfRepo) : undefined;
    },
  };
}

function latestAttestation(home: string, repo: string, pr: number): CouncilAttestation | undefined {
  const dir = join(home, 'attestations', ...repo.split('/'), String(pr));
  if (!existsSync(dir)) return undefined;
  let best: CouncilAttestation | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CouncilAttestation;
      const at = typeof parsed.at === 'object' && parsed.at ? (parsed.at as { value?: number }).value ?? 0 : 0;
      const bestAt = best && typeof best.at === 'object' && best.at ? (best.at as { value?: number }).value ?? 0 : -1;
      if (!best || at >= bestAt) best = parsed;
    } catch {
      // skip an unreadable record
    }
  }
  return best;
}

/** The live probe writes `<home>/self/probe/<head>.json` as `{ ok: boolean }` when it
 *  finishes on a head; no file means no probe ran, which the policy reads as not ok. */
function readProbeResult(home: string, head: string | undefined): boolean | undefined {
  if (!head) return undefined;
  const path = join(home, 'self', 'probe', `${head}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return Boolean((JSON.parse(readFileSync(path, 'utf8')) as { ok?: unknown }).ok);
  } catch {
    return undefined;
  }
}
