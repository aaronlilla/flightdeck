/**
 * The one place a question from an unattended worker lands.
 *
 * A worker cannot block on a prompt. Under the old runtime a session that raised
 * AskUserQuestion sat at it forever: it took no further tool calls, and the message queue
 * that was supposed to reach it delivered before the next tool call, which never came. So
 * the question is intercepted before it renders, written here, and the run parks with its
 * work committed and its lane released. An answer file brings it back.
 *
 * Entries are keyed by the question rather than by the run. Two workers stuck behind one
 * decision are one decision to make, and a retry that re-asks is the same wall, not a new
 * one. An inbox that grows a line per retry is an inbox nobody reads, which is the same
 * as having none.
 *
 * One JSON file per key, so a person can answer by editing a file and the runner will
 * pick it up without a protocol.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Ask {
  run: string;
  question: string;
  options?: string[];
  /** What kind of wall this is. A `blocker` propagates to every run sharing its key. */
  kind?: 'question' | 'blocker';
  ticket?: string;
}

export interface InboxEntry {
  key: string;
  question: string;
  options: string[];
  kind: 'question' | 'blocker';
  /** Every run that hit this wall, in the order they hit it. */
  runs: string[];
  /** How many times it has been asked. A repeat is counted, never dropped. */
  asked: number;
  at: number;
  answer?: string;
  answeredAt?: number;
  /** What the worker does about it: park, never wait. */
  disposition: 'park';
  ticket?: string;
}

/**
 * The identity of a question.
 *
 * Wording is normalised because the same wall gets described slightly differently each
 * time a model hits it: case and spacing carry no decision. The options do carry one, so
 * they are part of the key: "dev or staging" and "dev or prod" are different questions
 * however similar the sentence is.
 */
export function askKey(ask: Ask): string {
  const question = (ask.question ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const options = (ask.options ?? []).map((o) => o.trim().toLowerCase()).sort().join(' ');
  return createHash('sha256').update(`${question}${options}`).digest('hex').slice(0, 16);
}

export class Inbox {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** One entry, read from disk so an answer written by hand is seen. */
  entry(key: string): InboxEntry | undefined {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as InboxEntry;
    } catch {
      // A half-written entry is not an answer. Treating it as one would resume a run on
      // a decision nobody made.
      return undefined;
    }
  }

  all(): InboxEntry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.entry(name.slice(0, -'.json'.length)))
      .filter((found): found is InboxEntry => Boolean(found))
      .sort((a, b) => a.at - b.at);
  }

  /** Everything still waiting on a person. */
  open(): InboxEntry[] {
    return this.all().filter((found) => found.answer === undefined);
  }

  /**
   * Record a question and say what the worker should do about it.
   *
   * An identical question already open gains a count and, if it is a different run, a
   * name. One already answered reopens: the answer was for the last time it was asked,
   * and a worker asking again has a reason.
   */
  raise(ask: Ask): InboxEntry {
    const key = askKey(ask);
    const existing = this.entry(key);
    const now = Date.now();

    let entry: InboxEntry;
    if (existing && existing.answer === undefined) {
      entry = {
        ...existing,
        asked: existing.asked + 1,
        runs: existing.runs.includes(ask.run) ? existing.runs : [...existing.runs, ask.run],
      };
    } else if (existing) {
      entry = {
        ...existing,
        asked: existing.asked + 1,
        at: now,
        runs: existing.runs.includes(ask.run) ? existing.runs : [...existing.runs, ask.run],
      };
      delete entry.answer;
      delete entry.answeredAt;
    } else {
      entry = {
        key,
        question: ask.question,
        options: ask.options ?? [],
        kind: ask.kind ?? 'question',
        runs: [ask.run],
        asked: 1,
        at: now,
        disposition: 'park',
      };
    }
    if (ask.ticket) entry.ticket = ask.ticket;
    this.write(entry);
    return entry;
  }

  /** Answer an entry. An answer to a key nobody asked is ignored rather than invented. */
  answer(key: string, answer: string): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const answered: InboxEntry = { ...entry, answer, answeredAt: Date.now() };
    this.write(answered);
    return answered;
  }

  /**
   * What a resumed session is told.
   *
   * The question travels with the answer. The session being resumed asked it many turns
   * ago and a bare "staging" is not something it can act on.
   */
  resumePrompt(key: string): string {
    const entry = this.entry(key);
    if (!entry) return '';
    return [
      'You parked on a question. It has been answered.',
      '',
      `Question: ${entry.question}`,
      `Answer: ${entry.answer ?? '(none yet)'}`,
      '',
      'Carry on from where you stopped.',
    ].join('\n');
  }

  private write(entry: InboxEntry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(entry.key), JSON.stringify(entry, null, 2), 'utf8');
  }
}
