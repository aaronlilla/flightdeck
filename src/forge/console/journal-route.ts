/**
 * `GET /journal?since=&run=&limit=`: the append-only journal, rendered as the console's
 * own `JournalEntry` rows instead of the raw `ForgeEvent` shape the runner keeps.
 *
 * One line of text per event kind, from a small table (`textFor` below). `lanes.ts` and
 * `thread.ts` both reuse `textFor` and `jidFor` so a run's step text and its rail chips
 * describe the same event the same way the journal sheet does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ForgeEvent } from '../journal.js';
import type { JournalEntry, JournalResponse } from '../../shared/console-model.js';

/** One row `~/.forge/console/actions.jsonl` carries per console write. Written by the
 *  write half (S3); read here to answer `undoable`/`undone` for a journal row that came
 *  from a console action rather than the runner itself. */
export interface ActionsLedgerRow {
  jid: string;
  ts: number;
  kind: string;
  run?: string | null;
  text: string;
  undo: { kind: string; payload?: unknown } | null;
  undoneAt?: number;
}

export function actionsLedgerPath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'actions.jsonl');
}

/** Read-only: this module never writes the ledger. A missing or unreadable file reads as
 *  no console actions yet, never an error. */
export function readActionsLedger(path: string): ActionsLedgerRow[] {
  if (!existsSync(path)) return [];
  const rows: ActionsLedgerRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ActionsLedgerRow);
    } catch {
      // A half-written row is not a decision. Skipped, never thrown on.
    }
  }
  return rows;
}

/** The jid a journal row is known by: the row's own `id` when it has a short/mono shape
 *  already reachable, otherwise `J-<seq>` built off its position in the file -- both are
 *  stable across reads of the same journal, which is what lets `/journal/:jid/undo`
 *  (S3) find the same row back. */
export function jidFor(row: ForgeEvent): string {
  return row.id ? `J-${row.id.slice(0, 8)}` : `J-${row.seq}`;
}

/** One line per event kind. Anything not named here falls back to `<event> (<run>)` or
 *  just `<event>` for a row with no run. */
export function textFor(row: ForgeEvent): string {
  const run = row.run ?? '';
  switch (row.event) {
    case 'run.started': return `${run} started`;
    case 'run.finished': return `${run} finished${row.verdict ? ` (${row.verdict})` : ''}`;
    case 'run.handoff': return `${run} handed off${row.successor ? ` to ${row.successor}` : ''}`;
    case 'run.paused': return `${run} paused`;
    case 'run.resumed': return `${run} resumed`;
    case 'run.parked': return `${run} parked${row.key ? ` on ${String(row.key)}` : ''}`;
    case 'warden.parked': return `${run} parked by the warden`;
    case 'governor.parked': return `${run} parked by the governor (budget)`;
    case 'run.blocked': return `${run} blocked${row.reason ? `: ${String(row.reason)}` : ''}`;
    case 'run.unblocked': return `${run} unblocked`;
    case 'run.killed': return `${run} killed${row.reason ? `: ${String(row.reason)}` : ''}`;
    case 'run.nudged': return `${run} nudged`;
    case 'ask.raised': return `${run} asked a question`;
    case 'ask.answered': return `question answered${row.key ? ` (${String(row.key)})` : ''}`;
    case 'ask.auto-answered': return `question auto-answered${row.key ? ` (${String(row.key)})` : ''}`;
    case 'inbox.retired': return `stale ask retired${row.key ? ` (${String(row.key)})` : ''}`;
    case 'tool.start': return `${run} running ${String(row.tool ?? 'a tool')}`;
    case 'tool.end': return `${run} finished a tool call`;
    case 'turn.end': return `${run} finished a turn`;
    case 'liveness.stuck': return `${run || row.key} stuck (${String(row.signal ?? 'unknown')})`;
    case 'liveness.cleared': return `${row.key} cleared (${String(row.signal ?? 'unknown')})`;
    case 'registry.abandoned': return `${run} registry row abandoned`;
    case 'chain.blocked': return `chain ${String(row.packetId ?? '')} blocked at ${String(row.hop ?? '?')}${row.reason ? `: ${String(row.reason)}` : ''}`;
    case 'chain.unblocked': return `chain ${String(row.packetId ?? '')} unblocked`;
    case 'chain.provisioned': return `chain ${String(row.packetId ?? '')} provisioned`;
    case 'chain.launched': return `chain ${String(row.packetId ?? '')} launched (${String(row.runKey ?? '')})`;
    case 'chain.gated': return `chain ${String(row.packetId ?? '')} gated (${String(row.verdict ?? '')})`;
    case 'chain.merged': return `chain ${String(row.packetId ?? '')} merged`;
    case 'chain.stopped': return `chain ${String(row.packetId ?? '')} stopped: ${String(row.reason ?? '')}`;
    case 'jira.skipped': return 'jira handoff skipped (not configured)';
    case 'external.complete': return `${String(row.kind ?? 'write')} complete${row.ticket ? ` on ${String(row.ticket)}` : ''}`;
    case 'external.unknown': return `${String(row.kind ?? 'write')} outcome unknown${row.ticket ? ` on ${String(row.ticket)}` : ''}`;
    case 'decision.made': return `decision: ${String(row.text ?? row.decision ?? 'made')}`;
    case 'gotcha': return `gotcha logged${run ? ` (${run})` : ''}`;
    case 'proposal.opened': return `proposal opened${row.prUrl ? `: ${String(row.prUrl)}` : ''}`;
    default:
      return run ? `${row.event} (${run})` : row.event;
  }
}

/** `jid` -> the ledger row naming it, when a console write journaled one. */
function ledgerByJid(ledger: ActionsLedgerRow[]): Map<string, ActionsLedgerRow> {
  return new Map(ledger.map((entry) => [entry.jid, entry]));
}

export function toJournalEntry(row: ForgeEvent, ledger: Map<string, ActionsLedgerRow>): JournalEntry {
  const jid = jidFor(row);
  const ledgerRow = ledger.get(jid);
  return {
    jid,
    ts: row.at,
    kind: row.event,
    text: textFor(row),
    actor: row.actor ?? 'system',
    run: row.run ?? null,
    undoable: Boolean(ledgerRow?.undo),
    undone: Boolean(ledgerRow?.undoneAt),
  };
}

export interface JournalQuery {
  since?: number;
  run?: string;
  limit?: number;
}

/** Pure: `events` in append order, newest-last, the same order `replay()`/`JournalCache`
 *  hand back. Filters, then returns the newest `limit` rows (default 200) newest-first,
 *  which is what a journal sheet renders top to bottom. */
export function computeJournal(events: ForgeEvent[], ledgerRows: ActionsLedgerRow[], query: JournalQuery = {}): JournalResponse {
  const ledger = ledgerByJid(ledgerRows);
  let filtered = events;
  if (query.since !== undefined) {
    const since = query.since;
    filtered = filtered.filter((row) => row.at > since);
  }
  if (query.run) {
    const run = query.run;
    filtered = filtered.filter((row) => row.run === run);
  }
  const total = filtered.length;
  const limit = query.limit ?? 200;
  const tail = filtered.slice(Math.max(0, filtered.length - limit));
  const rows = tail.map((row) => toJournalEntry(row, ledger)).reverse();
  return { rows, total };
}

/** Ensures `~/.forge/console/` exists, for a first read before any write has run.
 *  Never writes the actions ledger itself -- that file belongs to the write half. */
export function ensureConsoleDir(forgeHomeDir: string): void {
  mkdirSync(join(forgeHomeDir, 'console'), { recursive: true });
}

/** A specimen-only convenience: appends one raw line to a ledger file, used by tests that
 *  need an undoable row on disk without depending on the write half's module. Never
 *  called from production read code. */
export function writeLedgerRowForTest(path: string, row: ActionsLedgerRow): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, `${text}${JSON.stringify(row)}\n`, 'utf8');
}
