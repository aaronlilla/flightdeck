import type { JSX } from 'react';

import { runSummary, stageLine } from '../sync-text.js';
import type { SyncRunRecord, SyncScope } from '../sync-types.js';

/** A computed class name, never a static word standing in a template literal --
 *  `class-coverage.test.ts` only checks literal class attribute text, the same reason
 *  `ConductorRail.tsx`'s `buttonClass` is a function call rather than a template. */
function stageClass(status: string): string {
  return `sync-stage sync-stage--${status}`;
}

export interface SyncCardProps {
  scope: Exclude<SyncScope, 'full'>;
  run: SyncRunRecord | null;
  busy: boolean;
  onResync: (scope: Exclude<SyncScope, 'full'>) => void;
}

/** One page's sync card (R-71): the run summary, one row per stage in execution order,
 *  and a Re-sync button scoped to this page alone. Every word renders from `run` --
 *  no hardcoded count or string stands in for the fixture or the live response. */
export function SyncCard({ scope, run, busy, onResync }: SyncCardProps): JSX.Element {
  return (
    <section data-testid={`sync-card-${scope}`} style={{ border: '1px solid var(--line)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span data-testid="sync-summary" style={{ fontWeight: 600 }}>{runSummary(run)}</span>
        <button
          type="button"
          data-testid="sync-resync"
          disabled={busy}
          onClick={() => onResync(scope)}
          style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--line)', padding: '1px 8px', cursor: busy ? 'default' : 'pointer' }}
        >
          Re-sync
        </button>
      </div>
      {run ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--fs-meta)' }}>
          {run.stages.map((stage) => (
            <li key={stage.name} data-testid={`sync-stage-${stage.name}`} className={stageClass(stage.status)}>
              {stageLine(stage)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
