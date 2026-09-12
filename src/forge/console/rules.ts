/**
 * The flight review's rules: `POST /proposals/:id/apply|dismiss|restore`, and the tick
 * that actually enforces the two kinds the console can propose on its own.
 *
 * Rules live in `~/.forge/console/rules.json`. `proposals.ts` (S2's, read-only) folds
 * generated proposals (`kill-after-fails`, `auto-answer`, one per `proposal.opened` row)
 * on top of whatever is stored here; this module only owns what a person did to one:
 * apply it, dismiss it, or restore a dismissed one. Enforcement is a plain 10-second
 * `setInterval` this module starts and the caller may `stop()` -- not a cron, not a
 * queue, because the only two things it ever does are "kill this run" and "answer this
 * ask," each already a small, already-tested action this module delegates rather than
 * reimplements.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Inbox } from '../inbox.js';
import { appendOnce, replay } from '../journal.js';
import { deliverAnswer } from '../runinbox.js';
import { journalInterviewAnswer } from '../intake/interviewPlanner.js';
import { consoleDir, recordAction, type ActionsLedger } from './actions-ledger.js';
import { killRun, type RunActionsDeps } from './run-actions.js';
import type { ActionResult, Rule } from '../../shared/console-model.js';

export function rulesPath(): string {
  return join(consoleDir(), 'rules.json');
}

interface StoredRule extends Rule {}

interface RulesFile {
  rules: StoredRule[];
}

function readRules(path: string): RulesFile {
  if (!existsSync(path)) return { rules: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RulesFile;
  } catch {
    return { rules: [] };
  }
}

function writeRules(path: string, value: RulesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

export interface RulesDeps {
  journalPath: string;
  ledger: ActionsLedger;
  path?: string;
}

export type RuleResponse = { status: number; body: ActionResult | { error: string } };

function findRule(file: RulesFile, id: string): StoredRule | undefined {
  return file.rules.find((rule) => rule.id === id);
}

export function applyRule(id: string, deps: RulesDeps): RuleResponse {
  const path = deps.path ?? rulesPath();
  const file = readRules(path);
  const rule = findRule(file, id);
  if (!rule) return { status: 404, body: { error: `no proposal ${id}` } };
  rule.status = 'applied';
  writeRules(path, file);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'rule.apply', text: `applied rule ${id}: ${rule.title}`,
    undo: { kind: 'rule-status', payload: { id, status: 'dismissed' } }, extra: { ruleId: id },
  });
  rule.jid = jid;
  writeRules(path, file);
  return { status: 200, body: { ok: true, jid, message: `applied ${id}`, undoable: true } };
}

export function dismissRule(id: string, deps: RulesDeps): RuleResponse {
  const path = deps.path ?? rulesPath();
  const file = readRules(path);
  const rule = findRule(file, id);
  if (!rule) return { status: 404, body: { error: `no proposal ${id}` } };
  rule.status = 'dismissed';
  writeRules(path, file);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'rule.dismiss', text: `dismissed rule ${id}: ${rule.title}`,
    undo: { kind: 'rule-status', payload: { id, status: 'open' } }, extra: { ruleId: id },
  });
  return { status: 200, body: { ok: true, jid, message: `dismissed ${id}`, undoable: true } };
}

export function restoreRule(id: string, deps: RulesDeps): RuleResponse {
  const path = deps.path ?? rulesPath();
  const file = readRules(path);
  const rule = findRule(file, id);
  if (!rule) return { status: 404, body: { error: `no proposal ${id}` } };
  rule.status = 'open';
  writeRules(path, file);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'rule.restore', text: `restored rule ${id}: ${rule.title}`, undo: null, extra: { ruleId: id },
  });
  return { status: 200, body: { ok: true, jid, message: `restored ${id}`, undoable: false } };
}

/** The `rule-status` undo executor `command.ts`'s undo dispatcher calls. */
export function setRuleStatus(id: string, status: Rule['status'], deps: RulesDeps): void {
  const path = deps.path ?? rulesPath();
  const file = readRules(path);
  const rule = findRule(file, id);
  if (!rule) return;
  rule.status = status;
  writeRules(path, file);
}

export interface EnforcementDeps {
  journalPath: string;
  rulesPath?: string;
  inbox: Inbox;
  runActions: RunActionsDeps;
  /** Failures today at or above this many trips `kill-after-fails`. */
  failsThreshold?: number;
}

function todayFailCounts(journalPath: string): Record<string, number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const { events } = replay(journalPath);
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.at < midnight.getTime()) continue;
    if (event.event !== 'run.blocked' && event.event !== 'engine.error') continue;
    if (!event.run) continue;
    counts[event.run] = (counts[event.run] ?? 0) + 1;
  }
  return counts;
}

/**
 * One pass of the two enforceable rule kinds. Exported as a plain function (rather than
 * hidden inside a class-owned timer) so a specimen can call it once under fake time and
 * assert exactly what it did, before `startEnforcementTick` ever wraps it in an interval.
 */
export async function enforceRulesOnce(deps: EnforcementDeps): Promise<void> {
  const path = deps.rulesPath ?? rulesPath();
  const file = readRules(path);
  const openRules = file.rules.filter((rule) => rule.status === 'open');
  if (!openRules.length) return;

  const fails = todayFailCounts(deps.journalPath);
  const threshold = deps.failsThreshold ?? 3;

  for (const rule of openRules) {
    if (rule.kind === 'kill-after-fails') {
      for (const [run, count] of Object.entries(fails)) {
        if (count < threshold) continue;
        const outcome = await killRun(run, `${rule.title}: ${count} fails today`, deps.runActions);
        appendOnce(deps.runActions.journalPath, {
          event: 'decision.made', actor: 'console', action: 'rule.enforced', run, ruleId: rule.id,
          text: `kill-after-fails enforced on ${run}`, ok: outcome.status === 200,
        });
      }
    } else if (rule.kind === 'auto-answer') {
      const pattern = rule.evidence;
      for (const ask of deps.inbox.open()) {
        if (!pattern || !ask.question.includes(pattern)) continue;
        // Re-read off disk rather than trusting the snapshot `open()` took before the
        // first `await deliverAnswer` (code review, 2026-09-12). An answer or a reply
        // that lands during one of those awaits -- the HTTP route, the Slack poller, a
        // separate `forge answer` process -- was overwritten, and with the author
        // argument the operator's own click was then journalled as the rule's.
        const fresh = deps.inbox.entry(ask.key);
        if (!fresh || fresh.answer !== undefined) continue;
        // A person is already on this one, so the rule stands down. `reply` is a
        // teammate's words waiting on the operator to confirm them; `passedTo` is a
        // question out with a teammate who has not replied yet. Answering either
        // discards a person's work: a pass closed by a heuristic drops the teammate's
        // reply with no acknowledgement, and the pass window is hours.
        // A person is already on this one, so the rule stands down. `reply` is a
        // teammate's words waiting on the operator to confirm them -- answering over it
        // overwrote the teammate's name, the only record that they replied at all.
        // `passedTo` is a question out with a teammate who has not replied yet; closing
        // it by heuristic discards their reply with no acknowledgement, and the pass
        // window is hours where the reply window is seconds.
        if (fresh.reply !== undefined || fresh.passedTo) continue;
        const answered = deps.inbox.answer(ask.key, rule.effect, `rule:${rule.id}`);
        if (answered) {
          await deliverAnswer(answered, ask.key, rule.effect);
          journalInterviewAnswer((row) => appendOnce(deps.runActions.journalPath, row), answered, `rule:${rule.id}`);
          appendOnce(deps.runActions.journalPath, {
            event: 'decision.made', actor: 'console', action: 'rule.enforced', ruleId: rule.id,
            text: `auto-answer enforced on ${ask.key}`,
          });
        }
      }
    }
  }
}

export interface EnforcementHandle {
  stop(): void;
}

/** Starts the 10-second tick. Returns a handle so a caller (or a test with fake timers)
 *  can stop it; the interval is `unref`'d so a long-running `forge up` process is never
 *  kept alive by this alone. */
export function startEnforcementTick(deps: EnforcementDeps, everyMs = 10_000): EnforcementHandle {
  const timer = setInterval(() => { void enforceRulesOnce(deps); }, everyMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}
