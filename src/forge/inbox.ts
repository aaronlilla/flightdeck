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
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface Ask {
  run: string;
  /** The stable goal id this run belongs to. Part of the key: B.3.7. */
  goal?: string;
  /** What the ask is about -- the tool name, typically. Part of the key: two different
   *  actions that happen to word their question the same way are two different walls. */
  actionTarget?: string;
  question: string;
  options?: string[];
  /** Index into `options` the worker itself recommends, if it has an opinion. `null`
   *  once `completeAskOptions` has run and found no usable recommendation (a reasoner
   *  failure, most often) -- distinct from `undefined`, which means nobody has looked
   *  at this ask's options at all yet. */
  recommended?: number | null;
  /** Whether `options` is exactly what the worker sent (`'worker'`) or was padded out
   *  by `completeAskOptions` (`'drafted'`). Set by the caller before `raise()`, never
   *  computed here -- the inbox does not know how an ask's options came to be. */
  optionSource?: 'worker' | 'drafted';
  /** What kind of wall this is. A `blocker` propagates to every run sharing its key. */
  kind?: 'question' | 'blocker';
  ticket?: string;
}

/** Pass to… (R-76): who an ask was handed to, when, which Slack thread carries it, and
 *  who answered in that thread. Written by `Inbox.pass`/`clearPass`/`attachReply`, never
 *  by `raise`, and projected onto `LaneQuestion` for the board to render. All four null
 *  means the ask was never passed. */
export interface PassFields {
  passedTo?: string | null;
  passedAt?: number | null;
  passedThread?: string | null;
  answeredBy?: string | null;
  /** The teammate's own words, attached but not accepted: the ask stays open until a
   *  person confirms it. */
  reply?: string;
  repliedAt?: number;
}

export interface InboxEntry extends PassFields {
  key: string;
  question: string;
  options: string[];
  /** See `Ask.recommended`: absent means nobody has looked yet, `null` means
   *  `completeAskOptions` looked and found nothing to recommend. */
  recommended?: number | null;
  optionSource?: 'worker' | 'drafted';
  kind: 'question' | 'blocker';
  /** Every run that hit this wall, in the order they hit it. */
  runs: string[];
  /** Every goal id an asking run named, in the order raised. What `forge answer` and the
   *  4120 server's /answer deliver a resume message to: a run's own segment name stops
   *  being live the moment a handoff renames it, but its goal id never does. Empty when
   *  no ask that raised this entry named one. */
  goals: string[];
  /** How many times it has been asked. A repeat is counted, never dropped. */
  asked: number;
  at: number;
  answer?: string;
  answeredAt?: number;
  /** What the worker does about it: park, never wait. */
  disposition: 'park';
  ticket?: string;
  /**
   * F3: computed fresh on every read, never stored on the file. `true` when none of
   * `runs` has a registry row left, meaning every run that ever hit this wall is gone
   * and answering it would resume nothing. Absent on any entry `projectStaleness` was
   * not asked to look at (e.g. a raw `entry()`/`all()` read that skips the projection).
   */
  stale?: boolean;
  /** Set alongside `stale: true`: one line saying why, for the console to show in place
   *  of the answer controls. */
  staleReason?: string;
}

/**
 * F3: an ask whose every run is dead stays open forever, with nothing to resume.
 *
 * `~/.forge/inbox/*.json` entries are keyed by the question, not the run, so a wall three
 * runs hit in a row (`forge-live-probe`, `forge-live-probe-3`, `forge-live-probe-5`) is
 * one entry, and it goes on showing Yes/No/free-text controls long after all three runs
 * are gone -- there is nothing left for an answer to reach. Computed rather than stored,
 * because a run's registry row can disappear at any time with no new inbox event to mark
 * it: reading `stale` off a stored value would go stale itself.
 */
/** How old an ask has to be, with no readable question text at all, before answering
 *  it is pointless regardless of whether a run is still alive to resume -- the
 *  NeedsYou board's own "stale ask" reading (2026-09-07 live-board finding: a parked
 *  lane's question came back with empty text and sat at the top of the board forever). */
const EMPTY_ASK_STALE_AGE_MS = 24 * 60 * 60_000;

/** R-76: the `Ask.run` prefix an item-scoped question carries (`intake/interviewPlanner.ts`
 *  mints these). Defined here because `isAskStale` is the one place the distinction
 *  matters and importing intake from the inbox would invert the dependency. */
export const ITEM_RUN_PREFIX = 'item:';

export function isAskStale(entry: InboxEntry, hasRegistryRow: (run: string) => boolean, now: number = Date.now()): boolean {
  if (entry.answer !== undefined) return false;
  if (entry.question.trim() === '' && now - entry.at > EMPTY_ASK_STALE_AGE_MS) return true;
  if (!entry.runs.length) return false;
  // R-76: an interview ask names the queue item it belongs to, not a launched process,
  // and a queued item has no registry row until it launches two hops later. Without this,
  // every interview question read as stale the moment it was raised: `forge status` filed
  // it under "not worth your time" and `forge clear --all` retired it, which silently
  // restarted the interview and abandoned any Slack thread already open on it. Whether
  // the item still exists is the queue's knowledge, not the inbox's, so the honest answer
  // here is "not stale" -- a question kept too long costs a line on a board, and one
  // retired by mistake costs a person's answer.
  if (entry.runs.some((run) => run.startsWith(ITEM_RUN_PREFIX))) return false;
  return entry.runs.every((run) => !hasRegistryRow(run));
}

/** Adds `stale`/`staleReason` to every entry, without mutating the input. */
export function projectStaleness<T extends InboxEntry>(
  entries: T[], hasRegistryRow: (run: string) => boolean,
): (T & { stale: boolean; staleReason?: string })[] {
  return entries.map((entry) => {
    const stale = isAskStale(entry, hasRegistryRow);
    return {
      ...entry,
      stale,
      ...(stale
        ? { staleReason: `every run that asked this (${entry.runs.join(', ')}) is gone; answering resumes nothing` }
        : {}),
    };
  });
}

/**
 * The identity of a question.
 *
 * Wording is normalised because the same wall gets described slightly differently each
 * time a model hits it: case and spacing carry no decision. The options do carry one, so
 * they are part of the key: "dev or staging" and "dev or prod" are different questions
 * however similar the sentence is.
 *
 * A `blocker` is scoped by wording alone, unchanged from before B.3.7: `driftBlocker`'s
 * whole point is that every run stuck behind the same base is the same wall, one answer
 * releasing all of them, and folding `run` into that key here would have split them back
 * into one entry each. `question` and `forge_ask`'s asks get the B.3.7 scoping (goal, run,
 * action target) instead, because those genuinely are a new wall each time a different run
 * hits one, even with identical wording.
 */
export function askKey(ask: Ask): string {
  const question = (ask.question ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const options = (ask.options ?? []).map((o) => o.trim().toLowerCase()).sort().join(' ');
  const scope = ask.kind === 'blocker' ? '' : `${ask.goal ?? ''}|${ask.run}|${ask.actionTarget ?? ''}`;
  return createHash('sha256').update(`${scope}::${question}${options}`).digest('hex').slice(0, 16);
}

export class Inbox {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** When the inbox directory itself was last written, read fresh every call. */
  mtime(): number | undefined {
    if (!existsSync(this.dir)) return undefined;
    return statSync(this.dir).mtimeMs;
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

    const goals = (current: string[]): string[] => {
      if (!ask.goal || current.includes(ask.goal)) return current;
      return [...current, ask.goal];
    };

    let entry: InboxEntry;
    if (existing && existing.answer === undefined) {
      entry = {
        ...existing,
        asked: existing.asked + 1,
        runs: existing.runs.includes(ask.run) ? existing.runs : [...existing.runs, ask.run],
        goals: goals(existing.goals ?? []),
      };
    } else if (existing) {
      entry = {
        ...existing,
        asked: existing.asked + 1,
        at: now,
        runs: existing.runs.includes(ask.run) ? existing.runs : [...existing.runs, ask.run],
        goals: goals(existing.goals ?? []),
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
        goals: goals([]),
        asked: 1,
        at: now,
        disposition: 'park',
      };
    }
    if (ask.ticket) entry.ticket = ask.ticket;
    if (ask.recommended !== undefined) entry.recommended = ask.recommended;
    if (ask.optionSource !== undefined) entry.optionSource = ask.optionSource;
    this.write(entry);
    return entry;
  }

  /**
   * Pass to… (R-76): records that this ask was handed to a teammate in a Slack thread.
   *
   * Written before the post goes out, so the card shows "passed" the instant the
   * operator clicks and the route can answer without waiting on Slack; `clearPass` rolls
   * it back when the post turns out to have failed. `answeredBy` stays null -- a pass is
   * not an answer.
   */
  pass(key: string, to: string, at: number, thread: string | null): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const passed: InboxEntry = { ...entry, passedTo: to, passedAt: at, passedThread: thread, answeredBy: null };
    this.write(passed);
    return passed;
  }

  /** Undoes `pass` after a failed post, so the board rolls the card back rather than
   *  showing a question as handed to someone who never saw it. */
  clearPass(key: string): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const cleared: InboxEntry = { ...entry, passedTo: null, passedAt: null, passedThread: null, answeredBy: null };
    this.write(cleared);
    return cleared;
  }

  /**
   * A teammate's reply, read off the thread this ask was passed into.
   *
   * The reply is stored as the entry's answer and `answeredBy` names who typed it, but
   * the ask stays OPEN: a sentence is not an option, and the machine never picks one on
   * a person's behalf. The operator confirms or changes it from the board, and that
   * click is what calls `answer`.
   */
  attachReply(key: string, from: string, text: string): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const attached: InboxEntry = { ...entry, answeredBy: from, reply: text, repliedAt: Date.now() };
    this.write(attached);
    return attached;
  }

  /** Answer an entry. An answer to a key nobody asked is ignored rather than invented.
   *
   *  `answeredBy` names a non-operator author that answered DIRECTLY rather than by
   *  attaching a reply for the operator to confirm -- today only an auto-answer rule
   *  (`console/rules.ts`). Found by code review, 2026-09-12: without it the entry
   *  reaches `answeredByOf` with no author at all, so the brief's `## Decisions` credits
   *  the operator with a call a heuristic made, while the journal row beside it already
   *  names the rule. Two records of one event that disagree is worse than either alone.
   *  Left unset, the operator is credited exactly as before. */
  answer(key: string, answer: string, answeredBy?: string): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const answered: InboxEntry = {
      ...entry, answer, answeredAt: Date.now(), ...(answeredBy ? { answeredBy } : {}),
    };
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

  /**
   * F3: `forge clear --all`'s side of retiring a stale ask. Moves the entry's file under
   * `retired/` rather than deleting it, so the question and every run that hit it stay on
   * disk for whoever wants to know what was actually asked. Returns `undefined` when
   * there was nothing at that key to move (nothing to journal, then).
   */
  retire(key: string): InboxEntry | undefined {
    const entry = this.entry(key);
    if (!entry) return undefined;
    const retiredDir = join(this.dir, 'retired');
    mkdirSync(retiredDir, { recursive: true });
    renameSync(this.pathFor(key), join(retiredDir, `${key}.json`));
    return entry;
  }
}
