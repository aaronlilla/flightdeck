import type { JSX } from 'react';
import { useState } from 'react';

import type { InboxEntry, RouterResult } from '../types.js';
import { InboxCard } from './InboxCard.js';

export interface InboxRailProps {
  open: InboxEntry[];
  onAnswer: (key: string, answer: string) => Promise<void>;
  /** F3: clears a stale ask. */
  onClearAsk: (key: string) => Promise<void>;
  /** X4: whether the server will actually act on a routed message. */
  routerEnabled: boolean;
  onRoute: (text: string) => Promise<RouterResult>;
}

/**
 * X4: the rail thread's own message box, below the open asks. Disabled and labeled
 * "router off" whenever the policy has the router turned off, which is the default
 * this cut ships with -- typing here does nothing until Aaron flips
 * `router.enabled` in the policy file.
 */
export function InboxRail({ open, onAnswer, onClearAsk, routerEnabled, onRoute }: InboxRailProps): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<RouterResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const send = async (): Promise<void> => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await onRoute(text);
      setLastResult(result);
      setText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that message did not go through');
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="inbox-rail" aria-label="inbox">
      <div className="inbox-rail__head">
        <h2 className="inbox-rail__title">Inbox</h2>
        <span className="pill">{open.length}</span>
      </div>
      {open.length === 0 ? (
        <p className="inbox-empty">Nothing waiting on you.</p>
      ) : (
        open.map((entry) => (
          <InboxCard key={entry.key} entry={entry} onAnswer={onAnswer} onClear={onClearAsk} />
        ))
      )}

      <div className="rail-thread">
        <p className="rail-thread__status" data-router-status={routerEnabled ? 'on' : 'off'}>
          {routerEnabled ? 'router on' : 'router off'}
        </p>
        <div className="inbox-card__free-text">
          <input
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={routerEnabled ? 'Send a message to the fleet' : 'router off'}
            aria-label="send a message to the fleet"
            disabled={!routerEnabled || sending}
          />
          <button
            type="button"
            className="btn"
            disabled={!routerEnabled || sending || !text.trim()}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
        {error ? <p className="inbox-card__error">{error}</p> : null}
        {lastResult ? (
          <p className="rail-thread__result">
            {lastResult.routed
              ? `routed as ${lastResult.outcome?.class ?? 'unknown'}`
              : (lastResult.reason ?? 'not routed')}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
