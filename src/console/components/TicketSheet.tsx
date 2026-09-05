import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import type { RunDetail } from '../types.js';

export interface TicketSheetProps {
  run: string;
  onClose: () => void;
}

/**
 * X3: opens from a lane tile. Packet and provenance come from `GET /run/:id`;
 * plan, PR and council fields render "not wired" until something in the
 * fleet actually writes them, per decision in the dispatch brief rather than
 * left blank the way a field that failed to load would be.
 */
export function TicketSheet({ run, onClose }: TicketSheetProps): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.getRun(run)
      .then((next) => { if (live) setDetail(next); })
      .catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : 'could not load this run'); });
    return () => { live = false; };
  }, [run]);

  return (
    <div className="ticket-sheet__backdrop" onClick={onClose}>
      <aside
        className="ticket-sheet"
        role="dialog"
        aria-label={`${run} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ticket-sheet__head">
          <h2 className="ticket-sheet__title">{run}</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="close">
            Close
          </button>
        </div>

        {error ? <p className="inbox-card__error">{error}</p> : null}

        {!detail && !error ? <p className="inbox-empty">Loading…</p> : null}

        {detail ? (
          <>
            <section className="ticket-sheet__section">
              <h3>Packet</h3>
              <pre className="ticket-sheet__packet">{detail.packet ?? 'No packet written for this run yet.'}</pre>
            </section>

            <section className="ticket-sheet__section">
              <h3>Plan</h3>
              <p className="ticket-sheet__not-wired">{detail.plan ?? 'not wired'}</p>
            </section>

            <section className="ticket-sheet__section">
              <h3>Pull request</h3>
              <p className="ticket-sheet__not-wired">{detail.prUrl ?? 'not wired'}</p>
            </section>

            <section className="ticket-sheet__section">
              <h3>Council packets</h3>
              <p className="ticket-sheet__not-wired">{detail.council ?? 'not wired'}</p>
            </section>

            <section className="ticket-sheet__section">
              <h3>Haiping&rsquo;s comments</h3>
              <p className="ticket-sheet__not-wired">{detail.comments ?? 'not wired'}</p>
            </section>

            <section className="ticket-sheet__section">
              <h3>Provenance</h3>
              <p>
                {detail.provenance.predecessor ? `from ${detail.provenance.predecessor}` : 'no predecessor'}
                {' · '}
                {detail.provenance.successor ? `handed off to ${detail.provenance.successor}` : 'no successor'}
              </p>
            </section>
          </>
        ) : null}
      </aside>
    </div>
  );
}
