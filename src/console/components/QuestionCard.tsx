import type { JSX } from 'react';
import { useState } from 'react';

/**
 * The one question card (UX rule 2): two to four options, the first recommended, and a
 * place to type a longer answer. The Board's Needs-you section, the lane sheet and the
 * Conductor rail all render through this; the rail's own row (`FD Rail.dc.html`, kind
 * `question`) keeps its typed answer in the composer below the list, so `freetext`
 * there is the pointer to it rather than an input of its own.
 */
export interface QuestionCardProps {
  /** The card's kicker: "BBZ-226 · Rate-limit the odds refresh endpoint" on the Board,
   *  "Question · BBZ-226" in the rail. */
  head: string;
  /** The right-hand stamp beside the kicker: "asked 9 min ago", or a clock time. */
  stamp: string;
  text: string;
  options: string[];
  /** Fires with the option's exact text, or the typed answer. */
  onAnswer: (answer: string) => void;
  /** `inline` draws the design's input + Answer row inside the card (Board, lane sheet);
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
}

function Marks(): JSX.Element {
  return <><i className="mk tl" /><i className="mk tr" /><i className="mk bl" /><i className="mk br" /></>;
}

export function QuestionCard(props: QuestionCardProps): JSX.Element {
  const { head, stamp, text, options, onAnswer, freetext, composerId, variant = 'board', placeholder, answer, onHead } = props;
  const [typed, setTyped] = useState('');
  const shown = options.slice(0, 4);
  const submitTyped = (): void => {
    const value = typed.trim();
    if (!value) return;
    onAnswer(value);
    setTyped('');
  };
  const rail = variant === 'rail';
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
      <p className="hd" style={{ margin: 0, fontSize: 'var(--fs-lead)', lineHeight: 1.25 }}>{text}</p>
      {answer !== undefined ? (
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Answered: {answer}</span>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((option, index) => (
              <button
                key={option} type="button" className="opt" data-testid="question-option"
                data-recommended={index === 0 ? 'true' : 'false'}
                onClick={() => onAnswer(option)}
              >
                <i /><span>{option}</span>
              </button>
            ))}
          </div>
          {freetext === 'inline' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <input
                className="inp warnFocus" data-testid="question-freetext" placeholder={placeholder ?? 'Or type your own answer…'}
                value={typed} onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); }}
              />
              <button type="button" className="btn warn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px' }} onClick={submitTyped}>Answer</button>
            </div>
          ) : (
            <label htmlFor={composerId} data-testid="question-freetext" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', cursor: 'pointer' }}>
              Pick one, or type a longer answer below and press Send.
            </label>
          )}
        </>
      )}
    </div>
  );
}

export { Marks };
