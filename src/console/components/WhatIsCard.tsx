import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import * as api from '../api.js';
import { Marks } from './QuestionCard.js';
import type { WhatIs } from '../../forge/console/whatis.js';

/**
 * What an identifier means, shown where the reader is already looking.
 *
 * Aaron, 2026-09-12: "when i hover over an item that has an acronym, like a bbz ticket
 * number, i should be able to see full detail of the ticket or whatever it is, ticket or
 * not." Then, on the first version of it: "it will close if you try to move the mouse to
 * it because the area is too little, the text looks terrible, it doesnt even look like
 * the bare minimum."
 *
 * Both of those are addressed below and both were the same mistake — a tooltip built as
 * a tooltip rather than as one of this console's cards. It is laid out like the blocker
 * card now (`BlockersView.tsx`): the same padding, the same corner marks, the same type
 * scale, a real heading rather than a 12px line, and its label column is a grid rather
 * than a fixed pixel width that everything else had to squeeze past.
 */

/** How long the pointer must rest before anything is fetched. Long enough that crossing
 *  a line of text costs no requests, short enough to feel like hovering. */
const HOVER_DELAY_MS = 220;

/**
 * How long the card stays up after the pointer leaves both it and its anchor.
 *
 * This is the fix for "it will close if you try to move the mouse to it". The card is
 * drawn into the document body so a scrolling ancestor cannot clip it, which means it is
 * NOT a descendant of the anchor: the browser fires `mouseleave` on the anchor the
 * instant the pointer starts travelling toward the card, and there is a gap to cross.
 * Closing on a delay, and cancelling that delay when the pointer arrives, makes the
 * journey survivable.
 */
const CLOSE_GRACE_MS = 260;

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="kick" style={{ fontSize: 'var(--fs-kicker)', color: 'var(--ink3)', margin: 0, whiteSpace: 'nowrap' }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 'var(--fs-ui)', color: 'var(--ink)', overflowWrap: 'anywhere' }}>{value}</dd>
    </>
  );
}

/**
 * The description, with a fade at its foot ONLY when there is more below it.
 *
 * The first version faded unconditionally, so the last line of a short description came
 * out greyed as though it had been cut off (screenshotted 2026-09-12). Whether the text
 * overflows is a fact about the rendered box, so it is measured after layout rather than
 * guessed at from the string length.
 */
function Description({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [text]);
  return (
    <div style={{ position: 'relative', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <p
        ref={ref} data-testid="whatis-body"
        style={{
          margin: 0,
          fontSize: 'var(--fs-body)', lineHeight: 1.5, color: 'var(--ink2)',
          maxHeight: 190, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}
      >
        {text}
      </p>
      {overflows ? (
        <span
          aria-hidden="true" data-testid="whatis-body-more"
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: 24, pointerEvents: 'none',
            background: 'linear-gradient(to bottom, transparent, var(--panel))',
          }}
        />
      ) : null}
    </div>
  );
}

function Body({ what }: { what: WhatIs }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 }}>
        <span className="key" data-testid="whatis-ref" style={{ fontSize: 'var(--fs-key)' }}>{what.ref}</span>
        {what.state ? (
          <span
            data-testid="whatis-state" className="kick"
            style={{ fontSize: 'var(--fs-kicker)', color: 'var(--warn)', whiteSpace: 'nowrap', flex: 'none' }}
          >
            {what.state}
          </span>
        ) : null}
      </div>

      {what.title ? (
        <h3 className="hd" data-testid="whatis-title" style={{ margin: 0, fontSize: 'var(--fs-cardhead)', lineHeight: 1.15, overflowWrap: 'anywhere' }}>
          {what.title}
        </h3>
      ) : null}

      {what.fields.length > 0 ? (
        // A grid, not a fixed label width: the longest label sets the column and every
        // value lines up with it, at any card width.
        <dl
          data-testid="whatis-fields"
          style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 16, rowGap: 5, margin: 0 }}
        >
          {what.fields.map((field) => <Field key={field.label} label={field.label} value={field.value} />)}
        </dl>
      ) : null}

      {what.body ? <Description text={what.body} /> : null}

      {what.url ? (
        <a
          href={what.url} target="_blank" rel="noopener noreferrer" data-testid="whatis-open"
          className="btn ghost"
          style={{ alignSelf: 'flex-start', textDecoration: 'none', fontSize: 'var(--fs-meta)', padding: '4px 12px' }}
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

/** How wide the card may grow. Read in two places — the layout and the placement maths —
 *  so they cannot disagree about where the right edge lands. */
const CARD_MAX_WIDTH = 460;

export function WhatIsHover({ refText, children, lookup }: WhatIsHoverProps): JSX.Element {
  const [what, setWhat] = useState<WhatIs | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
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

  /**
   * The pointer is over the anchor or the card. Cancels any pending close.
   *
   * The card carries this too, and that is belt and braces rather than the mechanism:
   * React propagates events from a portal up its own tree, not the DOM's, so entering the
   * card already reaches the anchor's handlers. Proven by neutering the card's own
   * `onMouseEnter` and watching every case stay green. Kept because it states the intent
   * and would still hold if this were ever rendered without a portal.
   */
  const hold = (): void => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const enter = (): void => {
    hold();
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(ask, HOVER_DELAY_MS);
  };

  /** The pointer left. Closing waits, so the gap between the anchor and the card can be
   *  crossed without the card disappearing out from under it. */
  const release = (): void => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { if (mounted.current) setOpen(false); }, CLOSE_GRACE_MS);
  };

  /** Where to draw the card, in viewport coordinates: flipped above the anchor when
   *  there is no room below, and pulled left when it would run off the right edge. */
  const place = (): { top: number; left: number; flipped: boolean } => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0, flipped: false };
    const below = window.innerHeight - rect.bottom;
    const flipped = below < 260 && rect.top > below;
    const top = flipped ? Math.max(8, rect.top - 8) : rect.bottom + 2;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_MAX_WIDTH - 8));
    return { top, left, flipped };
  };

  const at = open && what ? place() : null;

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={enter}
      onMouseLeave={release}
      onFocus={ask}
      onBlur={release}
      data-testid="whatis-anchor"
    >
      {children}
      {at && what ? createPortal((
        <span
          role="tooltip" data-testid="whatis-card"
          onMouseEnter={hold}
          onMouseLeave={release}
          style={{
            // Drawn into the body, not beside the anchor. The Needs-you strip scrolls
            // inside itself, and an absolutely positioned child of a scrolling box is
            // clipped by it -- the card rendered at the right size and place and was
            // invisible on screen. Fixed positioning off the anchor's own rect escapes
            // every such ancestor.
            position: 'fixed', top: at.top, left: at.left, zIndex: 60,
            ...(at.flipped ? { transform: 'translateY(-100%)' } : {}),
            border: '1px solid var(--line2)', background: 'var(--panel)', padding: '18px 20px',
            boxShadow: '0 10px 30px rgba(0,0,0,.22)', display: 'block', cursor: 'auto',
            // An absolutely positioned box takes its width from its containing block, and
            // the anchor sits inside a narrow board column -- so without these the card
            // came out about 140px wide and wrapped its state one letter per line.
            width: 'max-content', minWidth: 340, maxWidth: CARD_MAX_WIDTH,
            whiteSpace: 'normal', textAlign: 'left', font: 'inherit',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <Marks />
          <Body what={what} />
        </span>
      ), document.body) : null}
    </span>
  );
}
