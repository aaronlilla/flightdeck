import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import * as api from '../api.js';
import type { WhatIs } from '../../forge/console/whatis.js';

/**
 * What an identifier means, shown where the reader is already looking.
 *
 * Aaron, 2026-09-12: "when i hover over an item that has an acronym, like a bbz ticket
 * number, i should be able to see full detail of the ticket or whatever it is, ticket or
 * not."
 *
 * Every short reference on the board — `BBZ-169`, `PR #159`, a run's own name — is a
 * thing the reader is expected to already know. Linking them out to Jira or GitHub helps
 * only if you are willing to leave the page.
 *
 * Three things this deliberately does NOT do. It does not fetch on render: the request
 * goes out on hover, after a short delay, so sweeping the pointer across a board of
 * twenty keys costs nothing. It does not close while the pointer is inside it, so a
 * description can be read and a link can be clicked. And it never renders empty: a
 * reference that resolves to nothing says so.
 */

/** How long the pointer must rest before anything is fetched. Long enough that crossing
 *  a line of text costs no requests, short enough to feel like hovering. */
const HOVER_DELAY_MS = 250;

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span className="kick" style={{ fontSize: 'var(--fs-kicker)', color: 'var(--ink3)', width: 92, flex: 'none' }}>{label}</span>
      <span style={{ fontSize: 'var(--fs-meta)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function Body({ what }: { what: WhatIs }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span className="key" data-testid="whatis-ref">{what.ref}</span>
        {what.state ? <span data-testid="whatis-state" style={{ fontSize: 'var(--fs-kicker)', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink3)' }}>{what.state}</span> : null}
      </div>
      {what.title ? (
        <div className="hd" data-testid="whatis-title" style={{ fontSize: 'var(--fs-rowhead)', lineHeight: 1.2 }}>{what.title}</div>
      ) : null}
      {what.fields.length > 0 ? (
        <div data-testid="whatis-fields" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {what.fields.map((field) => <Row key={field.label} label={field.label} value={field.value} />)}
        </div>
      ) : null}
      {what.body ? (
        // Bounded and scrollable: a Jira description runs to any length, and a hover card
        // that grows past the window cannot be read or dismissed.
        <p
          data-testid="whatis-body"
          style={{ margin: 0, fontSize: 'var(--fs-meta)', color: 'var(--ink2)', maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {what.body}
        </p>
      ) : null}
      {what.url ? (
        <a
          href={what.url} target="_blank" rel="noopener noreferrer" data-testid="whatis-open"
          style={{ fontSize: 'var(--fs-meta)' }}
          onClick={(event) => event.stopPropagation()}
        >
          Open it
        </a>
      ) : null}
    </div>
  );
}

export interface WhatIsHoverProps {
  /** The identifier as it reads on screen. */
  refText: string;
  children: ReactNode;
  /** Test seam: answers instead of the real route. */
  lookup?: (ref: string) => Promise<WhatIs>;
}

export function WhatIsHover({ refText, children, lookup }: WhatIsHoverProps): JSX.Element {
  const [what, setWhat] = useState<WhatIs | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const ask = (): void => {
    setOpen(true);
    if (what || failed) return;
    const fetcher = lookup ?? api.whatIs;
    void fetcher(refText)
      .then((answer) => { if (mounted.current) setWhat(answer); })
      // A hover that cannot reach the server says nothing rather than showing an error
      // card over the text somebody is reading.
      .catch(() => { if (mounted.current) setFailed(true); });
  };

  const enter = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(ask, HOVER_DELAY_MS);
  };

  const leave = (): void => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  const anchorRef = useRef<HTMLSpanElement | null>(null);

  /** Where to draw the card, in viewport coordinates, flipped up when there is no room
   *  below and pulled left when it would run off the right edge. */
  const place = (): { top: number; left: number } => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0 };
    const width = 420;
    const below = window.innerHeight - rect.bottom;
    const top = below < 220 && rect.top > below ? Math.max(8, rect.top - 8 - 200) : rect.bottom + 4;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    return { top, left };
  };

  const at = open && what ? place() : null;

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={ask}
      onBlur={leave}
      data-testid="whatis-anchor"
    >
      {children}
      {at && what ? createPortal((
        <span
          role="tooltip" data-testid="whatis-card"
          style={{
            // Drawn into the body, not beside the anchor. The Needs-you strip scrolls
            // inside itself (`maxHeight: 34vh; overflow-y: auto`), and an absolutely
            // positioned child of a scrolling box is CLIPPED by it -- the card rendered
            // at the right size and place and was invisible on screen (screenshotted
            // 2026-09-12). Fixed positioning off the anchor's own rect escapes every
            // such ancestor.
            position: 'fixed', top: at.top, left: at.left, zIndex: 60,
            border: '1px solid var(--line2)', background: 'var(--panel)', padding: '12px 14px',
            boxShadow: '0 6px 20px rgba(0,0,0,.18)', display: 'block', cursor: 'auto',
            // An absolutely positioned box takes its width from its containing block, and
            // the anchor sits inside a narrow board column -- so without these the card
            // came out about 140px wide and wrapped the state one letter per line.
            width: 'max-content', minWidth: 280, maxWidth: 420,
            whiteSpace: 'normal', textAlign: 'left', font: 'inherit',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <Body what={what} />
        </span>
      ), document.body) : null}
    </span>
  );
}
