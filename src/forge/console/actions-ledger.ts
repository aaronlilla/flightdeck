/**
 * Every console write's audit trail.
 *
 * A write on the board is two rows, not one: a `decision.made` row in the fleet journal
 * (actor `console`), which is the same append-only trail every other Forge subsystem
 * already writes to, and a mirror row in `~/.forge/console/actions.jsonl` keyed by that
 * journal row's own id. The journal row is what makes a console kill authorise a real
 * `WardenActuator.kill` (it looks for a `decision.made` row naming the run and the
 * action); the ledger row is what lets the journal sheet render "undo" and know which
 * kinds of write have one.
 *
 * The ledger is append-only like the journal it mirrors: an undo does not rewrite the
 * original row, it appends a second row for the same `jid` with `undoneAt` set. `get`
 * folds a jid's rows in file order and returns the latest, so "undone" always reflects
 * the most recent word on it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { consoleDir } from '../paths.js';
import { appendOnce } from '../journal.js';
import { jidFor } from './journal-route.js';

export { consoleDir };

export function actionsLedgerPath(): string {
  return join(consoleDir(), 'actions.jsonl');
}

/** What running this row's inverse needs. `kind` names which undo executor applies;
 *  `payload` is whatever that executor needs (a run id, a previous cap, a rule id). */
export interface UndoSpec {
  kind: string;
  payload: Record<string, unknown>;
}

export interface LedgerRow {
  jid: string;
  ts: number;
  kind: string;
  run: string | null;
  text: string;
  undo: UndoSpec | null;
  undoneAt?: number;
}

export class ActionsLedger {
  constructor(private readonly path: string = actionsLedgerPath()) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(row: LedgerRow): LedgerRow {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }

  all(): LedgerRow[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerRow);
  }

  /** The latest row written for this jid (an undo appends a second row for the same
   *  jid, so "latest" is what a reader means by "the row's current state"). */
  get(jid: string): LedgerRow | undefined {
    let found: LedgerRow | undefined;
    for (const row of this.all()) if (row.jid === jid) found = row;
    return found;
  }

  markUndone(jid: string): LedgerRow | undefined {
    const row = this.get(jid);
    if (!row || row.undoneAt) return undefined;
    const updated: LedgerRow = { ...row, undoneAt: Date.now() };
    this.append(updated);
    return updated;
  }
}

export interface RecordActionOptions {
  /** Also written as the journal row's `action` field, since `WardenActuator.kill`'s
   *  `findDecision` matches on `event['action']` -- a console kill has to write the
   *  exact field name the actuator already reads, not a synonym. */
  kind: string;
  run?: string | null;
  text: string;
  undo: UndoSpec | null;
  /** Extra fields folded onto the `decision.made` row (`reason`, an integration id, a
   *  rule id -- whatever this write's own consumer needs to find it again). */
  extra?: Record<string, unknown>;
}

export interface ActionRecord {
  jid: string;
  ts: number;
  /** The `decision.made` row's own full id -- the form `findDecision`/`WardenActuator.kill`
   *  (and the documented `forge decide RUN kill "<reason>"` CLI) actually compare against.
   *  Never the same string as `jid`, which is `"J-"` plus only the first 8 hex characters,
   *  built for display (a receipt, `GET /journal`) and never a match for the full id a kill
   *  has to name. A caller authorising a kill must pass this, not `jid`. */
  id: string;
}

/**
 * The spine every write in `run-actions.ts` / `caps-write.ts` / `integrations.ts` /
 * `rules.ts` calls before answering: journal the decision, mirror it to the ledger,
 * hand back the id both rows share.
 */
export function recordAction(
  journalPath: string, ledger: ActionsLedger, options: RecordActionOptions,
): ActionRecord {
  const event = appendOnce(journalPath, {
    event: 'decision.made',
    actor: 'console',
    action: options.kind,
    ...(options.run ? { run: options.run } : {}),
    text: options.text,
    ...(options.extra ?? {}),
  });
  // The id a receipt hands back has to be the id `journal-route.ts` renders for this
  // same row (`J-` + the first 8 hex of its own uuid), or `GET /journal` shows one jid
  // for a decision and `POST /journal/:jid/undo` is asked for a different one nobody
  // wrote down.
  const jid = jidFor(event);
  ledger.append({
    jid,
    ts: event.at,
    kind: options.kind,
    run: options.run ?? null,
    text: options.text,
    undo: options.undo,
  });
  return { jid, ts: event.at, id: event.id };
}
