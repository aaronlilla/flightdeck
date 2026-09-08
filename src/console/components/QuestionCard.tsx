/**
 * `QuestionCard` (W2): where a worker's `forge_ask` finally becomes something a
 * person can read and answer. Full question text, four or more options with the
 * recommended one first and preselected, a free-text row, one Send button. A
 * question with no text (an old, empty-ask inbox row) shows no answer box at all.
 *
 * Used by the Conductor rail, the ticket sheet, and (in a trimmed form) the
 * needs-you plate, so a person sees the same question the same way wherever it
 * surfaces on the board.
 */
import type { JSX } from 'react';
import { useState } from 'react';

import { ACTIONS } from '../actions.js';
import { ActionButton } from './ActionButton.js';
import { Linkify } from './Linkify.js';

export interface QuestionCardProps {
  /** The inbox key `POST /answer` takes. Null for a fixture with no key of its own. */
  askKey: string | null;
  question: string;
  /** A person's name for whoever asked, already resolved by the caller. */
  from: string;
  askedAt: number;
  options: string[];
  /** The zero-based index into `options` the drafting pass singled out, or `null`
   *  when nothing was ever recommended. */
  recommended: number | null;
  /** Set once this ask has already been answered; renders the answered line and
   *  no controls at all. */
  answer?: string;
  /** The lane id this ask belongs to, for the no-question card's Resume button.
   *  Null when the caller has none to give. */
  laneId?: string | null;
  onCommand: (text: string) => void;
  repo?: string | null;
}

const cardStyle = { border: '1px solid var(--hand)', borderRadius: 4, maxWidth: '94%' } as const;

export function QuestionCard({
  askKey, question, from, options, recommended, answer, laneId = null, onCommand, repo,
}: QuestionCardProps): JSX.Element {
  const recommendedText = recommended !== null ? options[recommended] : undefined;
  const orderedOptions = recommendedText !== undefined
    ? [recommendedText, ...options.filter((o) => o !== recommendedText)]
    : options;
  const [selected, setSelected] = useState<string | null>(recommendedText ?? null);
  const [free, setFree] = useState('');
  const [usingFree, setUsingFree] = useState(false);
  const [sent, setSent] = useState(false);

  const trimmedQuestion = question.trim();

  if (answer !== undefined) {
    return (
      <div className="plate" data-testid="question-card" style={cardStyle}>
        <div className="lbl" style={{ padding: '7px 12px', color: 'var(--hand)' }}>Question · from {from}</div>
        <div className="m" style={{ padding: '0 12px 10px', fontSize: 'var(--fs-ui)', color: 'var(--run)' }}>
          answered: {answer}
        </div>
      </div>
    );
  }

  if (trimmedQuestion === '') {
    return (
      <div className="plate" data-testid="question-card-empty" style={cardStyle}>
        <div className="lbl" style={{ padding: '7px 12px', color: 'var(--hand)' }}>Question · from {from}</div>
        <div style={{ padding: '10px 12px', fontSize: 'var(--fs-body)', lineHeight: 1.4 }}>
          This run asked for something but sent no question
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
          {askKey ? (
            <ActionButton
              spec={ACTIONS.dismissAsk} args={[askKey]} actionRef={`qc-dismiss-${askKey}`}
              className="btnS" busy="Dismissing…"
            >
              Dismiss
            </ActionButton>
          ) : null}
          {laneId ? (
            <ActionButton
              spec={ACTIONS.resumeRun} args={[laneId]} actionRef={`qc-resume-${laneId}`}
              className="btnP" busy="Resuming…"
            >
              Resume
            </ActionButton>
          ) : null}
        </div>
      </div>
    );
  }

  const send = (text: string): void => {
    if (sent || !text.trim()) return;
    setSent(true);
    onCommand(`answer ${askKey ?? ''} ${text}`);
  };

  return (
    <div className="plate" data-testid="question-card" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--line)' }}>
        <span className="lbl" style={{ color: 'var(--hand)' }}>Question · from {from}</span>
      </div>
      <div style={{ padding: '10px 12px', fontSize: 'var(--fs-body)', lineHeight: 1.4 }}>
        <Linkify text={question} repo={repo} />
      </div>
      <div data-testid="question-options" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 10px' }}>
        {orderedOptions.map((o) => {
          const isRecommended = o === recommendedText;
          return (
            <label
              key={o}
              data-testid={isRecommended ? 'question-option-recommended' : 'question-option'}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 'var(--fs-ui)',
                border: `1px solid ${selected === o && !usingFree ? 'var(--hand)' : 'var(--line2)'}`, borderRadius: 4,
                overflowWrap: 'anywhere', width: '100%', cursor: 'pointer', lineHeight: 1.35,
              }}
            >
              <input
                type="radio" name={`qc-${askKey ?? 'ask'}`} checked={selected === o && !usingFree}
                onChange={() => { setSelected(o); setUsingFree(false); }}
              />
              <span style={{ flex: 1 }}>{o}</span>
              {isRecommended ? <span className="chip" style={{ flex: 'none' }}>Recommended</span> : null}
            </label>
          );
        })}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 'var(--fs-ui)' }}>
          <input type="radio" name={`qc-${askKey ?? 'ask'}`} checked={usingFree} onChange={() => setUsingFree(true)} />
          <input
            className="inp m" style={{ fontSize: 'var(--fs-ui)', flex: 1 }} placeholder="or type an answer"
            value={free} onChange={(e) => { setFree(e.target.value); setUsingFree(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && free.trim()) send(free); }}
          />
        </label>
      </div>
      <div style={{ padding: '0 12px 12px' }}>
        <button
          type="button" className="btnP" data-testid="question-send" disabled={sent}
          style={{ padding: '7px 11px', fontSize: 'var(--fs-ui)', opacity: sent ? 0.6 : 1 }}
          onClick={() => send(usingFree ? free : (selected ?? ''))}
        >
          {sent ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
