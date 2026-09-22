/**
 * Autopilot: nothing waits on the operator.
 *
 * Every open inbox question -- a teammate's Jira comment the feed could not settle, a
 * planner's interview question, a worker's blocker -- is resolved here within a tick,
 * after a bounded look at the code. Aaron's order, 2026-09-22: "no part of the system
 * should need my approval other than merging PRs", and "no reply is also a valid option:
 * if a reply would be annoying or unnecessary, don't".
 *
 * One mechanism, not one per source, because every stop in the system already funnels
 * through `Inbox.raise`. Resolving a question is exactly what the operator's own answer
 * does, through the same doors:
 *   - a Jira-feed question answered with text is posted to the ticket by the feed's own
 *     `postAnsweredQuestions` on its next pass; answered with LEAVE_OPTION it closes
 *     silently. "work" also queues the ticket, the same call an assigned ticket gets.
 *   - any other question is answered and delivered to its run, as `POST /answer` does.
 *
 * Switched by `~/.forge/console/autonomy.json` `answerAsks` (read every tick, so the
 * console's Settings toggle takes effect with no restart). Absent means ON.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { Reasoner } from '../contracts.js';
import { TAIL_BYTES, run as execRunDefault, type RunRequest, type RunResult } from '../exec.js';
import { FEED_RUNS, type InboxEntry } from '../inbox.js';
import { LEAVE_OPTION, replyRefusal } from './jiraFeed.js';
import { readabilityVerdict } from './readability.js';
import { termsFor } from './scout.js';

// ---------------------------------------------------------------------------------------
// Settings

export interface AutonomySettings {
  /** Resolve every open question without the operator. */
  answerAsks: boolean;
  /** Merge a pull request unattended once its audit passes. */
  autoMerge: boolean;
}

export const AUTONOMY_DEFAULTS: AutonomySettings = { answerAsks: true, autoMerge: true };

/** Reads the settings file; anything missing or unreadable falls back to ON. */
export function readAutonomy(path: string): AutonomySettings {
  try {
    if (!existsSync(path)) return { ...AUTONOMY_DEFAULTS };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutonomySettings>;
    return {
      answerAsks: raw.answerAsks !== false,
      autoMerge: raw.autoMerge !== false,
    };
  } catch {
    return { ...AUTONOMY_DEFAULTS };
  }
}

/** Where the console keeps these switches. */
export function autonomyPath(): string {
  return join(process.env['FORGE_HOME'] ?? join(homedir(), '.forge'), 'console', 'autonomy.json');
}

/** The Settings switch for unattended merges, read fresh on every call. */
export function autoMergeOn(): boolean {
  return readAutonomy(autonomyPath()).autoMerge;
}

export function writeAutonomy(path: string, patch: Partial<AutonomySettings>): AutonomySettings {
  const next = { ...readAutonomy(path), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------------------
// Research

export type ExecRunFn = (request: RunRequest) => Promise<RunResult>;

/** Up to this many files, across every configured checkout, go to the model. */
const MAX_FILES = 6;

/** The checked-out code the question talks about: one `git grep` per checkout for the
 *  question's own terms, the first few files that came back. Evidence, not an answer. */
export async function gatherEvidence(
  text: string,
  checkouts: readonly string[],
  deps: { execRun?: ExecRunFn; readFile?: (path: string) => string; owner: string },
): Promise<string> {
  const terms = termsFor(text);
  if (!terms.length || !checkouts.length) return '';
  const execRun = deps.execRun ?? execRunDefault;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const parts: string[] = [];
  let files = 0;
  for (const cwd of checkouts) {
    if (files >= MAX_FILES) break;
    let grep: RunResult;
    try {
      grep = await execRun({
        argv: ['git', 'grep', '-n', '-I', '-i', ...terms.flatMap((t) => ['-e', t])],
        cwd, owner: deps.owner, cls: 'script', raw: true, fullOutput: true,
      });
    } catch {
      continue;
    }
    if (grep.returncode !== 0) continue;
    const output = grep.full ?? grep.tail ?? '';
    const named: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^([^:]+):\d+:/.exec(line.trim());
      if (match?.[1] && !named.includes(match[1])) named.push(match[1]);
      if (named.length + files >= MAX_FILES) break;
    }
    for (const relative of named) {
      try {
        const path = isAbsolute(relative) ? relative : join(cwd, relative);
        parts.push(`--- ${cwd} :: ${relative}\n${readFile(path).slice(0, Math.min(TAIL_BYTES, 6000))}`);
        files += 1;
      } catch {
        // a file the grep named and the tree no longer has is evidence of nothing
      }
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------
// Deciding

export type AutoAction = 'answer' | 'silent' | 'work';

export interface AutoDecision {
  action: AutoAction;
  answer: string;
  why: string;
}

/** Why the team's comment checks would refuse this reply, or null when it would post.
 *  The same two checks the feed and the Jira write client run, applied BEFORE the answer
 *  is recorded, so a refused reply is reworded instead of lost. */
export function postRefusal(text: string, operatorNames: readonly string[]): string | null {
  const local = replyRefusal(text, operatorNames);
  if (local) return local;
  const verdict = readabilityVerdict('jira-comment', null, '', text, undefined, new Date().toISOString().slice(0, 10));
  return verdict.verdict === 'DENY' ? `readability refused it: ${verdict.reason}` : null;
}

/** The ticket as prompt text: summary, description and the last comments, capped. */
export function ticketAsText(key: string, read: { summary: string | null; status: string | null; assignee: string | null; description: string | null; comments?: Array<{ author: string; body: string }> }): string {
  const lines = [
    `${key}: ${read.summary ?? '(no summary)'} [${read.status ?? '?'}; assignee ${read.assignee ?? 'none'}]`,
    `Description: ${read.description ?? '(empty)'}`,
    ...(read.comments ?? []).map((c) => `Comment by ${c.author || 'someone'}: ${c.body}`),
  ];
  return lines.join('\n').slice(0, 6000);
}

export function isFeedAsk(entry: InboxEntry): boolean {
  return entry.runs.some((run) => FEED_RUNS.has(run));
}

export function autopilotPrompt(entry: InboxEntry, evidence: string, operatorName: string, ticketText = ''): string {
  const feed = isFeedAsk(entry);
  const drafted = entry.options.filter((o) => o !== LEAVE_OPTION);
  const recommended = typeof entry.recommended === 'number' ? entry.options[entry.recommended] : undefined;
  return [
    `You are ${operatorName}, a developer, clearing your own queue. Nobody else will look`,
    'at this: whatever you decide happens.',
    '',
    feed
      ? 'A teammate wrote this on a Jira ticket, and it was routed to you:'
      : 'A run working on your code stopped with this question:',
    entry.question,
    ...(entry.ticket ? [`Ticket: ${entry.ticket}`] : []),
    ...(drafted.length ? ['', 'Options already drafted:', ...drafted.map((o, i) => `${i + 1}. ${o}`)] : []),
    ...(recommended ? [`Recommended: ${recommended}`] : []),
    '',
    ...(ticketText ? ['The ticket as it stands in Jira right now:', ticketText, ''] : []),
    'Use only what the ticket and the code show. If the question asks what something says',
    'and neither shows it, say so plainly; never invent it.',
    '',
    'What the checked-out code says (grep hits, may be empty):',
    evidence || '(nothing matched)',
    '',
    'Decide one action:',
    ...(feed
      ? [
        '- answer: a reply is useful to the person who wrote it. Post the best short reply:',
        '  the drafted one if it is right, or a better one using the code above. Never',
        '  promise a date, money, or scope nobody agreed; say what you know and what you',
        '  will do next instead.',
        '- silent: no reply is needed, or one would be noise (an FYI, a thanks, a status',
        '  note, something already answered in the thread, a comment for someone else).',
        '- work: it asks for a change to the code. The ticket is queued for a worker and',
        '  your ANSWER is posted as a short acknowledgement.',
      ]
      : [
        '- answer: pick the best option or write the answer, decided from the code and the',
        '  question. When genuinely unsure, choose the safest option that keeps the work',
        '  moving and say the assumption in one clause.',
      ]),
    '',
    'A reply reads as the developer typing to a teammate: first person, casual, one to',
    'three sentences, no greeting, no sign-off, no mention of automation.',
    '',
    'Answer with exactly these three lines:',
    `ACTION: ${feed ? 'answer | silent | work' : 'answer'}`,
    'WHY: <one sentence>',
    'ANSWER: <the reply or answer; empty for silent>',
  ].join('\n');
}

export function parseAutoDecision(text: string, feed: boolean): AutoDecision | null {
  const action = /^\s*ACTION:\s*(answer|silent|work)\b/im.exec(text)?.[1]?.toLowerCase() as AutoAction | undefined;
  if (!action) return null;
  if (!feed && action !== 'answer') return null;
  const why = /^\s*WHY:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? '';
  const answerAt = /^\s*ANSWER:\s*/im.exec(text);
  const answer = answerAt ? text.slice(answerAt.index + answerAt[0].length).trim() : '';
  if (action !== 'silent' && !answer) return null;
  return { action, answer: action === 'silent' ? '' : answer, why };
}

// ---------------------------------------------------------------------------------------
// The tick

export interface AutopilotDeps {
  settings: () => AutonomySettings;
  open: () => InboxEntry[];
  reasoner: Pick<Reasoner, 'call'>;
  checkouts: () => string[];
  operatorName: () => string;
  /** Records the answer on the inbox entry, as the operator's own answer would. */
  answer: (key: string, text: string) => InboxEntry | undefined;
  /** Delivers an answered non-feed question to the run(s) that asked it. */
  deliver: (entry: InboxEntry, text: string) => Promise<void>;
  /** Retires a question nothing can act on (every asking run is gone). */
  retire: (key: string) => void;
  /** Queues and assigns the ticket, for a feed comment that asks for a change. */
  work: (ticket: string) => Promise<void>;
  journal: { append(row: Record<string, unknown>): void };
  execRun?: ExecRunFn;
  readFile?: (path: string) => string;
  /** The live ticket as text (summary, description, recent comments), read before
   *  deciding so an answer never guesses at what the ticket says. Optional. */
  ticketText?: (ticket: string) => Promise<string | null>;
  /** Most questions settled per tick; the rest wait one tick. */
  perTick?: number;
  now?: () => number;
}

export interface AutopilotResult { answered: string[]; silent: string[]; worked: string[]; retired: string[]; failed: string[] }

export async function runAutopilot(deps: AutopilotDeps): Promise<AutopilotResult> {
  const result: AutopilotResult = { answered: [], silent: [], worked: [], retired: [], failed: [] };
  if (!deps.settings().answerAsks) return result;
  const now = deps.now ?? Date.now;
  const open = deps.open().sort((a, b) => a.at - b.at).slice(0, deps.perTick ?? 3);
  for (const entry of open) {
    const feed = isFeedAsk(entry);
    if (entry.stale && !feed) {
      deps.retire(entry.key);
      deps.journal.append({
        event: 'autopilot.retired', actor: 'autopilot', key: entry.key,
        ...(entry.ticket ? { ticket: entry.ticket } : {}), why: entry.staleReason ?? 'no run left to resume', at: now(),
      });
      result.retired.push(entry.key);
      continue;
    }
    try {
      const ticket = entry.ticket && deps.ticketText ? (await deps.ticketText(entry.ticket).catch(() => null)) ?? '' : '';
      const evidence = await gatherEvidence(`${entry.question}\n${entry.options.join('\n')}`, deps.checkouts(), {
        owner: `autopilot-${entry.key}`,
        ...(deps.execRun ? { execRun: deps.execRun } : {}),
        ...(deps.readFile ? { readFile: deps.readFile } : {}),
      });
      const reply = await deps.reasoner.call({
        className: 'research', replyShape: 'text', prompt: autopilotPrompt(entry, evidence, deps.operatorName(), ticket),
      });
      let decision = parseAutoDecision(reply.text, feed);
      if (!decision) {
        // Unreadable is not a reason to stop the line: a feed comment with a draft takes
        // the draft, anything else takes its recommended or first option.
        const drafted = entry.options.find((o) => o !== LEAVE_OPTION);
        const pick = typeof entry.recommended === 'number' ? entry.options[entry.recommended] : drafted;
        decision = feed
          ? (drafted ? { action: 'answer', answer: drafted, why: 'took the drafted reply' } : { action: 'silent', answer: '', why: 'nothing drafted to send' })
          : { action: 'answer', answer: pick ?? 'Use your best judgement and keep going; note the assumption in the PR.', why: 'took the recommended option' };
      }
      // A feed reply must pass the team's comment checks, or the post fails later with
      // nobody watching. Two rewordings, then silence rather than a refused post.
      if (feed && decision.action !== 'silent') {
        const names = [deps.operatorName().split(/\s+/)[0] ?? ''].filter(Boolean);
        for (let round = 0; round < 2; round += 1) {
          const refusal = postRefusal(decision.answer, names);
          if (!refusal) break;
          const again = await deps.reasoner.call({
            className: 'research', replyShape: 'text',
            prompt: `${autopilotPrompt(entry, evidence, deps.operatorName(), ticket)}\n\nYour last ANSWER was refused by the team's comment check: ${refusal}\nIt was:\n${decision.answer}\nRewrite it so it passes, same three lines.`,
          });
          const next = parseAutoDecision(again.text, feed);
          if (next && next.action !== 'silent') decision = { ...next, action: decision.action === 'work' ? 'work' : next.action };
          else if (next) { decision = next; break; }
        }
        if (decision.action !== 'silent' && postRefusal(decision.answer, names)) {
          decision = { action: decision.action === 'work' ? 'work' : 'silent', answer: decision.action === 'work' ? 'On it.' : '', why: `${decision.why} (reply kept failing the comment check)` };
        }
      }
      if (decision.action === 'work' && entry.ticket) await deps.work(entry.ticket);
      const text = decision.action === 'silent' ? LEAVE_OPTION : decision.answer;
      const answered = deps.answer(entry.key, text);
      if (!answered) throw new Error(`the inbox has no ${entry.key}`);
      if (!feed) await deps.deliver(answered, text);
      deps.journal.append({
        event: 'autopilot.answered', actor: 'autopilot', key: entry.key, action: decision.action,
        ...(entry.ticket ? { ticket: entry.ticket } : {}),
        reason: decision.why, answer: text.slice(0, 400), evidenceChars: evidence.length, at: now(),
      });
      (decision.action === 'silent' ? result.silent : decision.action === 'work' ? result.worked : result.answered).push(entry.key);
    } catch (error) {
      deps.journal.append({
        event: 'autopilot.failed', actor: 'autopilot', key: entry.key,
        ...(entry.ticket ? { ticket: entry.ticket } : {}),
        reason: error instanceof Error ? error.message : String(error), at: now(),
      });
      result.failed.push(entry.key);
    }
  }
  return result;
}
