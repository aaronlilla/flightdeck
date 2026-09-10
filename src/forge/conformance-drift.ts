/**
 * Whether a run's last few tool calls still serve its own brief.
 *
 * "Every N turns a Haiku `evaluate` call sees the brief's acceptance criteria and the last
 * N tool calls: still on task, with a reason. Two consecutive no's park." This is that
 * check: a `Reasoner` call on the `evaluate` class (Haiku, per `model-policy.json`), the
 * brief's own `## Definition of Done` as the criteria, and a park -- with both verdicts
 * carried verbatim -- once two `no`s land back to back. A single `no` is a run correcting
 * itself mid-turn, not drift; only two in a row is.
 */
import { conformanceDriftKey } from './drift-blockers.js';
import type { Journal } from './journal.js';
import type { Reasoner } from './contracts.js';

export interface DriftActuator {
  park(run: string, reason: string): Promise<boolean>;
}

export interface ConformanceDriftDeps {
  reasoner: Reasoner;
  journal: Journal;
  actuator: DriftActuator;
}

const DOD_HEADING = /^##[ \t]+Definition of Done[ \t]*\r?\n/im;
const NEXT_HEADING = /^##[ \t]+\S/m;

/**
 * The brief's own `## Definition of Done` section, verbatim, or `undefined` when the
 * brief declares none. There is no fallback criteria to invent: a run with nothing
 * declared has nothing this checker can hold it to.
 */
export function extractDoD(brief: string): string | undefined {
  const start = DOD_HEADING.exec(brief);
  if (!start) return undefined;
  const bodyStart = start.index + start[0].length;
  const rest = brief.slice(bodyStart);
  NEXT_HEADING.lastIndex = 0;
  const next = NEXT_HEADING.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body.length ? body : undefined;
}

/**
 * Fewer recent calls than this and there is nothing to judge: a run that has read its brief
 * and opened three files has not drifted, it has started. Three runs were parked on
 * 2026-09-08 ten minutes in, on the verdict "no tool calls have been made yet".
 */
export const MIN_CALLS_TO_JUDGE = 5;

export function buildPrompt(dod: string, recentToolCalls: string[]): string {
  return [
    "A coding agent is working through a brief. Decide whether its most recent tool calls are",
    'in service of that brief, or about something else entirely.',
    '',
    'The Definition of Done below is the finish line, not a checklist the calls must already',
    'satisfy. Unfinished work is still on task. Reading files, editing files, running tests,',
    'installing dependencies, searching the repository and committing are all on task when they',
    'plausibly belong to this brief. Answer "no" only when the calls are clearly about a',
    'different task, a different repository, or a file the brief would never touch.',
    '',
    'Definition of Done:',
    dod,
    '',
    'Recent tool calls, oldest first:',
    ...recentToolCalls.map((call) => `- ${call}`),
    '',
    'Answer "yes" or "no" as the first word, then one short reason.',
  ].join('\n');
}

/** `false` only when the response's first word is `no`. Anything else -- "yes", a blank
 *  or malformed response -- reads as on task: a run does not park because the classifier
 *  stumbled, only because it said so twice in a row. */
export function isOnTask(responseText: string): boolean {
  return !/^\s*no\b/i.test(responseText ?? '');
}

export class ConformanceDrift {
  /** Verdict text, most recent last, kept to the last two, per run. */
  private readonly history = new Map<string, string[]>();

  constructor(private readonly deps: ConformanceDriftDeps) {}

  async check(
    run: string, dod: string, recentToolCalls: string[],
  ): Promise<{ onTask: boolean; parked: boolean; judged: boolean }> {
    if (recentToolCalls.length < MIN_CALLS_TO_JUDGE) {
      return { onTask: true, parked: false, judged: false };
    }
    const result = await this.deps.reasoner.call({
      className: 'evaluate', prompt: buildPrompt(dod, recentToolCalls), run,
    });
    const onTask = isOnTask(result.text);

    if (onTask) {
      this.history.set(run, []);
      return { onTask: true, parked: false, judged: true };
    }

    const kept = [...(this.history.get(run) ?? []), result.text].slice(-2);
    this.history.set(run, kept);
    if (kept.length < 2) return { onTask: false, parked: false, judged: true };

    await this.deps.actuator.park(run, 'conformance drift: two consecutive off-task verdicts');
    this.deps.journal.append({
      event: 'warden.parked', run, actor: 'warden', signal: 'drift',
      key: conformanceDriftKey(run), verdicts: kept,
    });
    this.history.set(run, []);
    return { onTask: false, parked: true, judged: true };
  }
}

// -----------------------------------------------------------------------------------------
// always-on-warden R-54: the transcript-reading extension.
//
// `ConformanceDrift` above sees eight tool names; it cannot tell a worker faithfully doing
// the wrong thing from one doing the right thing, because it never reads what the worker
// actually wrote or ran. `TranscriptDrift` reads the literal transcript tail (the run's own
// SDK session file) and judges against the brief's mission and Definition of Done, in one
// bounded `drift-judge` call (Haiku); only when that call says `off-brief` does a second,
// pricier `drift-confirm` call (Sonnet) get spent, and only its verdict ever parks a run.
// -----------------------------------------------------------------------------------------

export type TranscriptVerdict = 'on-brief' | 'drifting' | 'off-brief';

export interface TranscriptDriftActuator {
  nudge(run: string, message: string): Promise<void>;
  park(run: string, reason: string): Promise<boolean>;
}

export interface TranscriptDriftDeps {
  reasoner: Reasoner;
  journal: Journal;
  actuator: TranscriptDriftActuator;
}

/** How much of the transcript tail this reads -- the last N lines of the run's own SDK
 *  JSONL session file, oldest first, which is already the shape a transcript reader
 *  would print. Truncation to the class's token budget happens by trimming lines from
 *  the front, never by summarising, so the judge always sees real, unedited bytes. */
export const TRANSCRIPT_TAIL_LINES = 40;

export function buildTranscriptPrompt(
  mission: string, dod: string | undefined, transcriptTail: string,
): string {
  return [
    "A coding agent is working through a brief. Judge its most recent work from the",
    'transcript below -- not from tool names alone, which can look on-task while the',
    'actual edits, commands and file paths are not.',
    '',
    'Mission:',
    mission,
    ...(dod ? ['', 'Definition of Done:', dod] : []),
    '',
    'Transcript tail (most recent work, oldest first):',
    transcriptTail,
    '',
    'Reply with a single JSON object: {"verdict": "on-brief" | "drifting" | "off-brief",',
    '"reason": "<one sentence>"}. "on-brief": the work plausibly serves the brief above,',
    'even if unfinished. "drifting": the work has wandered off the brief but is not yet a',
    'different task. "off-brief": the work is clearly a different task, a different',
    'repository, or files the brief would never touch.',
  ].join('\n');
}

/** Parses the judge/confirm reply. Anything that does not parse to a recognised verdict
 *  reads as `on-brief` -- the same fail-safe-open choice `isOnTask` makes above: a run
 *  never parks because the classifier stumbled, only because it clearly said so. */
export function parseTranscriptVerdict(responseText: string): { verdict: TranscriptVerdict; reason: string } {
  try {
    const match = /\{[\s\S]*\}/.exec(responseText ?? '');
    const parsed = JSON.parse(match ? match[0] : responseText) as { verdict?: unknown; reason?: unknown };
    const verdict = parsed.verdict;
    if (verdict === 'on-brief' || verdict === 'drifting' || verdict === 'off-brief') {
      return { verdict, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
    }
  } catch {
    // Falls through to the fail-safe-open default below.
  }
  return { verdict: 'on-brief', reason: 'unparseable judge reply, defaulting to on-brief' };
}

export class TranscriptDrift {
  /** Runs already journaled `drift.skipped` for having no brief, so a run that never
   *  gets one is not renotified every cadence tick for its whole lifetime. */
  private readonly skippedForNoBrief = new Set<string>();

  constructor(private readonly deps: TranscriptDriftDeps) {}

  /** One drift check. `briefPath` is only used for the nudge's own text (so the run
   *  knows what to re-read); a run with `mission === undefined` (no brief at all) is
   *  journaled `drift.skipped` once and never touched again by this checker. */
  async check(
    run: string, mission: string | undefined, dod: string | undefined,
    transcriptTail: string, briefPath: string | undefined,
  ): Promise<{ verdict: TranscriptVerdict; reason: string } | undefined> {
    if (mission === undefined) {
      if (!this.skippedForNoBrief.has(run)) {
        this.skippedForNoBrief.add(run);
        this.deps.journal.append({ event: 'drift.skipped', run, actor: 'warden', reason: 'no brief' });
      }
      return undefined;
    }

    const judgePrompt = buildTranscriptPrompt(mission, dod, transcriptTail);
    const judgeResult = await this.deps.reasoner.call({ className: 'drift-judge', prompt: judgePrompt, run });
    let { verdict, reason } = parseTranscriptVerdict(judgeResult.text);
    let cls = 'drift-judge';

    if (verdict === 'off-brief') {
      const confirmResult = await this.deps.reasoner.call({ className: 'drift-confirm', prompt: judgePrompt, run });
      const confirmed = parseTranscriptVerdict(confirmResult.text);
      verdict = confirmed.verdict;
      reason = confirmed.reason;
      cls = 'drift-confirm';
    }

    this.deps.journal.append({ event: 'drift.checked', run, actor: 'warden', verdict, reason, cls });

    if (verdict === 'drifting') {
      await this.deps.actuator.nudge(
        run, `Drift check: ${reason} -- re-read the brief${briefPath ? ` at ${briefPath}` : ''}.`,
      );
    } else if (verdict === 'off-brief') {
      await this.deps.actuator.park(run, `drift confirmed off-brief: ${reason}`);
    }

    return { verdict, reason };
  }
}
