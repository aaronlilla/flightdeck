import type { JSX } from 'react';
import { useState } from 'react';

import { durationWords } from '../laneVM.js';

/**
 * The one question card (UX rule 2): two to four options, the first recommended, and a
 * place to type a longer answer. The Needs-you strip, the lane sheet and the Conductor
 * rail all render through this; the rail's own row (`FD Rail.dc.html`, kind `question`)
 * keeps its typed answer in the composer below the list, so `freetext` there is the
 * pointer to it rather than an input of its own.
 *
 * R-75 adds the strip's three extras, all optional so the other surfaces are unchanged:
 * number keys on the first four options, the evidence disclosure, and Pass to….
 */

/** Pass to… (spec `doctrine/design/operator-experience.md` §3). `passedTo` and
 *  `passedAt` come from the server's own `LaneQuestion` fields or from a click that has
 *  not come back yet; `pending` says which. `error` is the server's refusal, shown
 *  inline with a Retry while the card sits back on its options. */
export interface QuestionPass {
  names: string[];
  onPass: (name: string) => void;
  passedTo: string | null;
  passedAt: number | null;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
}

export interface QuestionCardProps {
  /** The card's kicker: "BBZ-226 · Rate-limit the odds refresh endpoint" on the strip,
   *  "Question · BBZ-226" in the rail. */
  head: string;
  /** The right-hand stamp beside the kicker: "asked 9 min ago", or a clock time. */
  stamp: string;
  text: string;
  options: string[];
  /** Fires with the option's exact text, or the typed answer. */
  onAnswer: (answer: string) => void;
  /** `inline` draws the design's input + Answer row inside the card (strip, lane sheet);
   *  `composer` draws the rail's hint line, labelled for the composer it points at. */
  freetext: 'inline' | 'composer';
  /** The rail variant's composer id, so the hint is a real label for it. */
  composerId?: string;
  /** A rail card sits 48px in from the left, under the timestamp column. */
  variant?: 'board' | 'rail';
  placeholder?: string;
  /** Once answered, the options give way to the answer line. */
  answer?: string;
  /** The rail variant: clicking the kicker makes this question the composer's topic. */
  onHead?: () => void;
  /** R-75: number the first four options, so a key can reach them. */
  keys?: boolean;
  /** R-75: what the disclosure holds. Closed by default; absent means no disclosure. */
  evidence?: string[];
  /** R-75: Pass to…, on a lane question only. */
  pass?: QuestionPass;
  /** R-75: the teammate who answered a passed question, from the server's own field. */
  answeredBy?: string | null;
  /** Now, for the "passed 4 min ago" elapsed line. */
  now?: number;
}

function Marks(): JSX.Element {
  return <><i className="mk tl" /><i className="mk tr" /><i className="mk bl" /><i className="mk br" /></>;
}

/** R-75: how many options a number key reaches. Kept in step with the strip's own
 *  `KEYED_OPTIONS`; past this the option is a click or a typed answer. */
const KEYED = 4;

function PassControl({ pass, now }: { pass: QuestionPass; now: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button" data-testid="question-pass" className="btn ghost"
        style={{ fontSize: 'var(--fs-meta)', padding: '4px 10px' }}
        onClick={() => setOpen((o) => !o)}
      >
        Pass to…
      </button>
      {open ? (
        <div
          data-testid="question-pass-menu"
          style={{ position: 'absolute', top: '100%', left: 0, zIndex: 2, display: 'flex', flexDirection: 'column', border: '1px solid var(--line2)', background: 'var(--panel)' }}
        >
          {pass.names.map((name) => (
            <button
              key={name} type="button"
              style={{ font: 'inherit', fontSize: 'var(--fs-meta)', textAlign: 'left', padding: '5px 14px', background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--ink)' }}
              onClick={() => { setOpen(false); pass.onPass(name); }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
      {pass.error ? (
        <>
          <span data-testid="question-pass-error" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{pass.error}</span>
          <button
            type="button" data-testid="question-pass-retry" className="btn ghost"
            style={{ fontSize: 'var(--fs-meta)', padding: '4px 10px' }}
            onClick={pass.onRetry}
          >
            Retry
          </button>
        </>
      ) : null}
      {void now}
    </div>
  );
}

export function QuestionCard(props: QuestionCardProps): JSX.Element {
  const {
    head, stamp, text, options, onAnswer, freetext, composerId, variant = 'board', placeholder, answer, onHead,
    keys = false, evidence, pass, answeredBy = null, now = Date.now(),
  } = props;
  const [typed, setTyped] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);
  const shown = options.filter((option) => option.trim().length > 0);
  const prompt = text.trim() || 'No question text';
  const submitTyped = (): void => {
    const value = typed.trim();
    if (!value) return;
    onAnswer(value);
    setTyped('');
  };
  const rail = variant === 'rail';
  // Out with a teammate: the options step aside until it comes back, or until a refusal
  // rolls the card back onto them.
  const passedTo = pass && !pass.error ? pass.passedTo : null;
  const answered = answeredBy !== null && answeredBy !== undefined;
  const hideOptions = answer !== undefined || answered || passedTo !== null;
  return (
    <div
      data-testid="question-card" data-card="question"
      style={{
        position: 'relative', border: '1px solid var(--warn)', padding: rail ? 12 : '12px 14px',
        display: 'flex', flexDirection: 'column', gap: rail ? 10 : 8, ...(rail ? { marginLeft: 48 } : {}),
      }}
    >
      <Marks />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        {rail
          ? <span className="kick" style={{ color: 'var(--warn)', fontWeight: 700, cursor: onHead ? 'pointer' : undefined }} onClick={onHead}>{head}</span>
          : <span className="key" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{head}</span>}
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', whiteSpace: 'nowrap', flex: 'none' }}>{stamp}</span>
      </div>
      <p className="hd" dir="auto" style={{ margin: 0, fontSize: 'var(--fs-lead)', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{prompt}</p>
      {evidence && evidence.length > 0 ? (
        <div>
          <button
            type="button" data-testid="question-evidence" className="disc"
            style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-meta)', color: 'var(--ink3)', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setShowEvidence((o) => !o)}
          >
            <span className="tri" style={{ transform: showEvidence ? 'rotate(90deg)' : undefined }} />
            Why it is asking
          </button>
          {showEvidence ? (
            <div data-testid="question-evidence-body" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
              {evidence.map((line) => <span key={line}>{line}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
      {answered ? (
        <div data-testid="question-answered" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
            Answered by {answeredBy}{pass?.passedAt ? ` · ${durationWords(now - pass.passedAt)} ago` : ''}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button" data-testid="question-confirm" className="btn warn"
              style={{ fontSize: 'var(--fs-key)', padding: '6px 18px' }}
              onClick={() => onAnswer(shown[0] ?? '')}
            >
              Confirm
            </button>
            <button
              type="button" data-testid="question-change" className="btn ghost"
              style={{ fontSize: 'var(--fs-key)', padding: '6px 18px' }}
              onClick={() => setShowEvidence(true)}
            >
              Change
            </button>
          </div>
        </div>
      ) : passedTo !== null ? (
        <span
          data-testid="question-passed" data-pending={pass?.pending ? 'true' : 'false'}
          style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}
        >
          Passed to {passedTo}{pass?.passedAt ? ` · ${durationWords(now - pass.passedAt)}` : ''}{pass?.pending ? ' ·' : ''}
          {pass?.pending ? <i data-testid="question-passed-mark" className="tri" style={{ opacity: 0.6 }} /> : null}
        </span>
      ) : answer !== undefined ? (
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Answered: {answer}</span>
      ) : null}
      {hideOptions ? null : (
        <>
          <div data-testid="question-options" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((option, index) => (
              <button
                key={option} type="button" className="opt" data-testid="question-option"
                data-recommended={index === 0 ? 'true' : 'false'}
                {...(keys && index < KEYED ? { 'data-key': String(index + 1) } : {})}
                onClick={() => onAnswer(option)}
              >
                <i />
                {keys && index < KEYED ? <kbd style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', marginRight: 6 }}>{index + 1}</kbd> : null}
                <span dir="auto" style={{ overflowWrap: 'anywhere' }}>{option}</span>
              </button>
            ))}
          </div>
          {freetext === 'inline' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <input
                className="inp warnFocus" data-testid="question-freetext" placeholder={placeholder ?? 'Other…'}
                value={typed} onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); }}
              />
              <button type="button" className="btn warn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px' }} onClick={submitTyped}>Answer</button>
            </div>
          ) : (
            <label htmlFor={composerId} data-testid="question-freetext" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', cursor: 'pointer' }}>
              Or type below
            </label>
          )}
        </>
      )}
      {pass ? <PassControl pass={pass} now={now} /> : null}
    </div>
  );
}

export { Marks };
