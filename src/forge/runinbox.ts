/**
 * Messages into a worker that is already running.
 *
 * The old runtime queued a note for a session and delivered it before that session's next
 * tool call. A session parked at a prompt never makes one, so the note never arrived, and
 * the queue looked like a channel while being a dead letter box. On 2026-09-04 a worker
 * was told by hand that its pull request conflicted with master, and it did not find out
 * until it re-read its brief forty minutes later.
 *
 * Here the delivery is an in-process `PreToolUse` hook. Anything unread rides out as
 * `additionalContext` on the very next tool call and is marked read. It never denies the
 * call it rides on: a message is information, and turning it into a refusal would make
 * telling a worker something an act of stopping it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { runDir } from './paths.js';

export interface RunMessage {
  id: string;
  at: number;
  /** Breaks the tie when two messages share a millisecond. */
  seq: number;
  from: string;
  text: string;
  readAt?: number;
}

export class RunInbox {
  private readonly dir: string;

  constructor(run: string) {
    this.dir = join(runDir(run), 'inbox');
    mkdirSync(this.dir, { recursive: true });
  }

  send(text: string, from = 'console'): RunMessage {
    // The timestamp alone is not an order. Two messages sent in the same millisecond
    // share it, and the filename sort then falls through to a random id, so "rebase
    // first" and "then push" can arrive the wrong way round. A sequence taken from how
    // many are already there breaks the tie in the order they were written.
    const sequence = existsSync(this.dir)
      ? readdirSync(this.dir).filter((name) => name.endsWith('.json')).length
      : 0;
    const message: RunMessage = { id: randomUUID(), at: Date.now(), seq: sequence, from, text };
    writeFileSync(
      join(this.dir, `${String(message.at).padStart(16, '0')}-`
        + `${String(sequence).padStart(6, '0')}-${message.id}.json`),
      JSON.stringify(message, null, 2), 'utf8',
    );
    return message;
  }

  all(): RunMessage[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as RunMessage;
        } catch {
          return undefined;
        }
      })
      .filter((message): message is RunMessage => Boolean(message))
      // Ordered twice on purpose: the filename carries the sequence and so does the
      // record. Either alone is enough, which means breaking one of them leaves the
      // suite green -- watched. That is deliberate depth rather than a redundant sort,
      // so tidying one away will not go red and should not be read as permission.
      .sort((a, b) => (a.at - b.at) || ((a.seq ?? 0) - (b.seq ?? 0)));
  }

  unread(): RunMessage[] {
    return this.all().filter((message) => !message.readAt);
  }

  /** Marked read only after delivery, so a crash mid-injection loses nothing. */
  markRead(ids: string[]): void {
    const wanted = new Set(ids);
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      try {
        const message = JSON.parse(readFileSync(path, 'utf8')) as RunMessage;
        if (!wanted.has(message.id) || message.readAt) continue;
        writeFileSync(path, JSON.stringify({ ...message, readAt: Date.now() }, null, 2), 'utf8');
      } catch {
        // A torn message is not delivered and not marked read. It stays for a person.
      }
    }
  }
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: string;
  };
  /** The messages just delivered, for a caller watching whether they get acknowledged. */
  messageIds?: string[];
  /** The delivered messages' own text, unwrapped from the "MESSAGE FOR THIS RUN" envelope. */
  rawText?: string;
}

/**
 * The PreToolUse hook a worker runs in process.
 *
 * Returns nothing when there is nothing waiting, which is the common case and has to cost
 * nothing: this runs before every tool call a worker makes.
 */
export async function injectMessages(
  run: string, _input: Record<string, unknown>,
): Promise<HookOutput | undefined> {
  const inbox = new RunInbox(run);
  const waiting = inbox.unread();
  if (!waiting.length) return undefined;

  const rawText = waiting.map((message) => message.text).join('\n\n');
  const body = waiting
    .map((message) => `[${new Date(message.at).toISOString()} from ${message.from}]\n${message.text}`)
    .join('\n\n');
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `MESSAGE FOR THIS RUN. Read it before the tool call you were about to make; it may `
        + `change what that call should be.\n\n${body}`,
    },
    messageIds: waiting.map((message) => message.id),
    rawText,
  };
  // Marked read only once the return value is fully built, so a throw while building it
  // (a malformed message, a future field this loop learns to reject) leaves the message
  // unread rather than losing it silently on the way to a value that was never delivered.
  inbox.markRead(waiting.map((message) => message.id));
  return output;
}

/** What `SdkEngine.answer` looks like, without importing the class itself: `runinbox.ts`
 *  is a dependency of `sdkengine.ts`, so a hard import the other way would be circular. */
export interface AnswerableEngine {
  answer(run: string, key: string, text: string): Promise<{ delivered: boolean }>;
}

/**
 * Everything `forge answer` and the 4120 server's `/answer` both have to do once an
 * inbox entry is answered, in one place so neither can fix half the problem the other
 * still has.
 *
 * The cross-process path (every real invocation of either caller) queues the resume text
 * into the goal's own inbox -- `entry.goals` when an ask recorded one, `entry.runs`
 * otherwise -- because that is the id the live PreToolUse hook actually polls
 * (`injectMessages(deps.goal, ...)`), not the per-segment run name a handoff renames.
 * `engine`, when this process happens to hold the answered run's live session, resumes it
 * in place immediately.
 */
export async function deliverAnswer(
  entry: { runs: string[]; goals: string[]; question: string },
  key: string,
  answerText: string,
  engine?: AnswerableEngine,
): Promise<{ delivered: string[] }> {
  const resumeText = `Question: ${entry.question}\nAnswer: ${answerText}`;
  const inboxTargets = entry.goals.length ? entry.goals : entry.runs;
  for (const target of inboxTargets) {
    new RunInbox(target).send(resumeText, 'console');
  }

  const delivered: string[] = [];
  if (engine) {
    for (const run of entry.runs) {
      const result = await engine.answer(run, key, answerText);
      if (result.delivered) delivered.push(run);
    }
  }
  return { delivered };
}
