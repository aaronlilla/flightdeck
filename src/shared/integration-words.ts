/**
 * The two sentences a data-source row shows, composed from the row itself.
 *
 * Shared rather than server-only because the stub server's fixtures build rows by hand
 * and must produce exactly the sentences the real route produces; a second copy of this
 * switch is a second answer, and the drifted copy is the one the design parity run would
 * not catch.
 */
import type { Integration } from './console-model.js';

/** The state sentence and the consequence sentence, with no clock in either. */
export function integrationWordsFor(row: Integration): { status: string; note: string } {
  const scope = row.scope ? `${row.scope} · ` : '';
  switch (row.status) {
    case 'ok':
      return { status: 'Connected', note: `${scope}${row.desc}` };
    case 'down':
      return {
        status: `Not connected${row.cause ? ` — ${row.cause}` : ''}`,
        note: row.effect ?? (row.dependents.length
          ? `Stops ${row.dependents.length} agent${row.dependents.length === 1 ? '' : 's'}.`
          : row.desc),
      };
    case 'degraded':
      return { status: 'Slow', note: row.desc };
    case 'off':
      return { status: 'Off', note: row.desc };
    case 'checking':
    case 'busy':
      return { status: 'Checking…', note: row.desc };
    default:
      return { status: row.status, note: row.desc };
  }
}

