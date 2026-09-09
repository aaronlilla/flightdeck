import type { JSX } from 'react';

import { durationWords, laneHeadline } from '../laneVM.js';
import type { Integration, Lane } from '../../shared/console-model.js';
import { QuestionCard } from './QuestionCard.js';

/**
 * The Board's "Needs you" section (`FD Board.dc.html`): one question card per lane that
 * asked something, with the agent's own options, a place to type a different answer,
 * and the Answer button. Anything else that needs a person (a blocker, a merge) has
 * its own section on the Board or the Blockers tab.
 */
export interface Need {
  kind: 'lane';
  id: string;
  key: string;
  title: string;
  /** The question text. */
  line: string;
  options: string[];
  askKey: string;
  askedAt: number;
  cta: { label: string; run: () => void };
}

export function buildNeeds(
  lanes: Lane[], _integrations: Integration[], onOpen: (kind: 'lane', id: string) => void,
  _onOpenSettings?: () => void, _now?: number,
): Need[] {
  const needs: Need[] = [];
  for (const lane of lanes) {
    if (!lane.question || lane.retiredAt !== null) continue;
    const head = laneHeadline(lane);
    needs.push({
      kind: 'lane', id: lane.id, key: lane.ticket ?? '', title: lane.title ?? head.main, line: lane.question.text,
      options: lane.question.opts, askKey: lane.question.key, askedAt: lane.question.askedAt,
      cta: { label: 'Answer', run: () => onOpen('lane', lane.id) },
    });
  }
  needs.sort((a, b) => a.askedAt - b.askedAt);
  return needs;
}

export interface NeedsYouProps {
  items: Need[];
  now: number;
  /** Fires with `answer <askKey> <text>`, the command the rail sends for a question. */
  onCommand: (laneId: string, command: string) => void;
}

export function NeedsYou({ items, now, onCommand }: NeedsYouProps): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section data-testid="needs-you" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h6 className="sec" style={{ color: 'var(--warn)' }}>Needs you <span className="n">{items.length} {items.length === 1 ? 'question' : 'questions'}</span></h6>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {items.map((need) => (
          <QuestionCard
            key={need.askKey}
            head={need.key ? `${need.key} · ${need.title}` : need.title}
            stamp={`asked ${durationWords(now - need.askedAt)} ago`}
            text={need.line}
            options={need.options}
            freetext="inline"
            onAnswer={(answer) => onCommand(need.id, `answer ${need.askKey} ${answer}`)}
          />
        ))}
      </div>
    </section>
  );
}
