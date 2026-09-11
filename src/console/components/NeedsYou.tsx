import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { durationWords, laneHeadline } from '../laneVM.js';
import type { Lane, Message } from '../../shared/console-model.js';
import { QuestionCard } from './QuestionCard.js';

/**
 * R-75 item 3 (spec `doctrine/design/operator-experience.md` §5): the Needs-you strip,
 * mounted above the tab bar on every view. Aaron, 2026-09-11: "questions need to be
 * asked differently somehow than they are now."
 *
 * One thing at a time, worst first: a raised blocker, then a confirm, then a question,
 * oldest first inside a kind. The recommended option leads. Number keys 1 to 4 answer
 * the card on screen; past four options the rest are a click or the typed answer. A
 * counter says how many are waiting, and when nothing is, the strip is one line.
 */

/** The teammates a question can be handed to (spec §3). Stream C (R-76) carries the
 *  Slack half; this stream posts the command and renders what comes back. */
export const PASS_NAMES = ['Jason', 'Joe', 'Haiping', 'Harrison'];

/** How many options a number key reaches. Past this, click or type the answer. */
export const KEYED_OPTIONS = 4;

export interface NeedOption {
  label: string;
  /** The command the console posts when this option is chosen. */
  cmd: string;
}

export interface Need {
  kind: 'blocker' | 'confirm' | 'lane';
  /** The lane the command is about, for the page's own topic tracking. */
  id: string;
  key: string;
  title: string;
  /** The question, or the blocker's headline. */
  line: string;
  options: NeedOption[];
  askKey: string;
  askedAt: number;
  /** What the card's disclosure holds: the node's own step, and the context behind the
   *  ask. Every line is real data off the lane or the card, never a placeholder. */
  evidence: string[];
  /** Pass to… (`LaneQuestion`, added by the spec PR): what the server says about this
   *  ask having been handed to someone. Null means not passed; the client never writes
   *  these itself. */
  passedTo: string | null;
  passedAt: number | null;
  answeredBy: string | null;
  /** Only a lane question can be passed: a blocker or a confirm is not a question. */
  passable: boolean;
}

/** The kind order is the strip's order: what is stopping an agent outranks what is
 *  waiting on a yes, which outranks a question the agent can still work around. */
const KIND_RANK: Record<Need['kind'], number> = { blocker: 0, confirm: 1, lane: 2 };

/** The recommended option first (spec §5), the rest in the order the pipeline gave
 *  them. A recommendation the ask does not carry leaves the order alone. */
function recommendedFirst(opts: string[], recommended: number | null | undefined): string[] {
  if (recommended === null || recommended === undefined) return opts;
  const pick = opts[recommended];
  if (pick === undefined) return opts;
  return [pick, ...opts.filter((_, i) => i !== recommended)];
}

function laneEvidence(lane: Lane): string[] {
  const lines = [`Step ${lane.stepN} of ${lane.stepTotal}: ${lane.stepText}`];
  const why = lane.reason ?? lane.plain;
  if (why) lines.push(why);
  if (lane.question?.optionSource === 'drafted') lines.push('Options drafted, not the agent’s own');
  return lines;
}

function cardEvidence(card: Message): string[] {
  const lines: string[] = [];
  if (card.body) lines.push(card.body);
  if (card.blast) lines.push(card.blast);
  for (const row of card.meta ?? []) lines.push(`${row.k}: ${row.v}`);
  return lines.length > 0 ? lines : [card.text];
}

/**
 * Everything that needs a person, in one ordered list: the blocker and confirm cards
 * off the thread response's second field (R-75 item 1), and every lane with an open
 * question. A lane the fleet already retired is not waiting on anyone.
 */
export function buildNeeds(lanes: Lane[], cards: Message[], _now?: number): Need[] {
  const needs: Need[] = [];
  for (const card of cards) {
    if (card.type !== 'blocker' && card.type !== 'confirm') continue;
    if (card.resolved) continue;
    const options: NeedOption[] = (card.btns ?? []).map((button) => ({ label: button.label, cmd: button.cmd }));
    needs.push({
      kind: card.type,
      id: card.lane ?? card.source,
      key: card.kicker ?? '',
      title: card.title ?? card.text,
      line: card.title ?? card.text,
      options: options.length > 0 ? options : [{ label: 'Confirm', cmd: `confirm ${card.k}` }, { label: 'Not now', cmd: `dismiss ${card.k}` }],
      askKey: card.askKey ?? card.k,
      askedAt: card.ts,
      evidence: cardEvidence(card),
      passedTo: null,
      passedAt: null,
      answeredBy: null,
      passable: false,
    });
  }
  for (const lane of lanes) {
    if (!lane.question || lane.retiredAt !== null) continue;
    const head = laneHeadline(lane);
    const question = lane.question;
    const opts = recommendedFirst(question.opts, question.recommended);
    needs.push({
      kind: 'lane',
      id: lane.id,
      key: lane.ticket ?? '',
      title: lane.title?.trim() || head.main,
      line: question.text,
      options: opts.map((option) => ({ label: option, cmd: `answer ${question.key} ${option}` })),
      askKey: question.key,
      askedAt: question.askedAt,
      evidence: laneEvidence(lane),
      passedTo: question.passedTo ?? null,
      passedAt: question.passedAt ?? null,
      answeredBy: question.answeredBy ?? null,
      passable: true,
    });
  }
  needs.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (a.askedAt - b.askedAt));
  return needs;
}

export interface NeedsYouProps {
  items: Need[];
  now: number;
  /** Posts a command through the page's existing command route. Resolves when the
   *  server has answered; rejects with the refusal, which rolls the card back. */
  onCommand: (laneId: string, command: string) => void | Promise<unknown>;
}

/** What this strip believes about one ask while its command is still in the air. Spec
 *  §10: the click applies at once, the response clears the mark, a refusal rolls it
 *  back with the reason and a Retry. */
interface PassState {
  name: string;
  pending: boolean;
  error: string | null;
}

export function NeedsYou({ items, now, onCommand }: NeedsYouProps): JSX.Element {
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(0);
  const [passes, setPasses] = useState<Record<string, PassState>>({});
  const stripRef = useRef<HTMLElement | null>(null);

  const total = items.length;
  const at = Math.min(index, Math.max(total - 1, 0));
  const need = items[at];

  const post = (target: Need, command: string): void => {
    setPending((n) => n + 1);
    Promise.resolve(onCommand(target.id, command))
      .catch(() => undefined)
      .finally(() => setPending((n) => Math.max(0, n - 1)));
  };

  const answer = (target: Need, text: string): void => {
    const option = target.options.find((o) => o.label === text);
    post(target, option ? option.cmd : `answer ${target.askKey} ${text}`);
    // Optimistic (spec §10): move on now, do not wait for the server.
    setIndex((i) => Math.min(i + 1, Math.max(total - 1, 0)));
  };

  const pass = (target: Need, name: string): void => {
    setPasses((map) => ({ ...map, [target.askKey]: { name, pending: true, error: null } }));
    Promise.resolve(onCommand(target.id, `pass ${target.askKey} ${name}`))
      .then(() => setPasses((map) => ({ ...map, [target.askKey]: { name, pending: false, error: null } })))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        // Rolled back: the card goes back to its options with the reason and a Retry.
        setPasses((map) => ({ ...map, [target.askKey]: { name, pending: false, error: reason } }));
      });
  };

  // Number keys answer the card on screen. Bound on the document rather than on the
  // strip, so a reader does not have to click the strip first -- and skipped whenever
  // the keystroke belongs to something a person is typing in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!need || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > KEYED_OPTIONS) return;
      const option = need.options[digit - 1];
      if (!option) return;
      event.preventDefault();
      answer(need, option.label);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  if (!need) {
    return (
      <section
        data-testid="needs-you-empty" ref={stripRef}
        style={{ padding: '6px 16px', borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}
      >
        Nothing needs you
      </section>
    );
  }

  const passState = passes[need.askKey];
  const passedTo = passState?.error ? null : passState?.name ?? need.passedTo;
  const passPending = passState?.pending ?? false;
  const stamp = need.kind === 'lane' ? `asked ${durationWords(now - need.askedAt)} ago` : durationWords(now - need.askedAt);

  // Bounded on purpose: the strip sits above everything else in a column layout, so an
  // unbounded card squashes the rail and the board to nothing -- measured 2026-09-11,
  // the rail's own list came out 45px tall. It scrolls inside itself instead.
  return (
    <section
      data-testid="needs-you" ref={stripRef}
      style={{ borderBottom: '1px solid var(--line)', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '34vh', overflowY: 'auto', flex: 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <h6 className="sec" style={{ margin: 0, color: 'var(--warn)' }}>Needs you</h6>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
          {pending > 0 ? <span data-testid="needs-you-pending">sending…</span> : null}
          <button
            type="button" data-testid="needs-you-prev" className="btn ghost" disabled={at === 0}
            style={{ fontSize: 'var(--fs-meta)', padding: '2px 8px' }}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            Previous
          </button>
          <span data-testid="needs-you-counter" style={{ fontVariantNumeric: 'tabular-nums' }}>{at + 1} of {total}</span>
          <button
            type="button" data-testid="needs-you-next" className="btn ghost" disabled={at >= total - 1}
            style={{ fontSize: 'var(--fs-meta)', padding: '2px 8px' }}
            onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
          >
            Next
          </button>
        </div>
      </div>
      <QuestionCard
        key={need.askKey}
        head={need.key && need.title !== need.key ? `${need.key} · ${need.title}` : need.title}
        stamp={stamp}
        text={need.line}
        options={need.options.map((option) => option.label)}
        keys
        evidence={need.evidence}
        freetext="inline"
        onAnswer={(text) => answer(need, text)}
        {...(need.passable ? {
          pass: {
            names: PASS_NAMES,
            onPass: (name: string) => pass(need, name),
            passedTo,
            passedAt: passState ? (passState.pending ? now : need.passedAt) : need.passedAt,
            pending: passPending,
            error: passState?.error ?? null,
            onRetry: () => pass(need, passState?.name ?? PASS_NAMES[0]!),
          },
          answeredBy: need.answeredBy,
        } : {})}
        now={now}
      />
    </section>
  );
}
