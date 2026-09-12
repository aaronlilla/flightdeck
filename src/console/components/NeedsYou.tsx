import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { durationWords, laneHeadline } from '../laneVM.js';
import type { Blocker, Lane, Message } from '../../shared/console-model.js';
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
  kind: 'blocker' | 'confirm' | 'question' | 'lane';
  /** This need's own id, unique across kinds. `askKey` alone is not: a card uses its
   *  own key or its message key, a lane uses the inbox ask key, and the two id spaces
   *  are not namespaced against each other. Everything the strip remembers about a
   *  card -- which one is on screen, which is out with a teammate, which has a command
   *  in the air -- is keyed on this, never on `askKey`. */
  uid: string;
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

/** The kind order, applied only between two cards a person can actually answer: what is
 *  stopping an agent outranks what is waiting on a yes, which outranks a question the
 *  agent can still work around. */
const KIND_RANK: Record<Need['kind'], number> = { blocker: 0, confirm: 1, question: 2, lane: 3 };

/**
 * Whether a person could answer this card if it were on screen right now.
 *
 * The strip's whole job is to put the next answerable thing in front of someone, and
 * kind alone does not say which those are. Measured on the live console, 2026-09-12:
 * 67 cards on the strip, every title the string `confirm?`, every one of them ranked
 * ahead of the real questions by kind. Aaron: "the UI is totally worthless, how am i
 * going to answer questions when they look like this".
 *
 * Two things make a card answerable, and it needs both. It has to carry words a person
 * can read -- a card whose only text is a fallback constant asks nothing. And it has to
 * offer a way to reply. Everything else about it, its kind included, is a tie-break.
 *
 * The title is deliberately NOT one of the fields read here. It is a kicker the strip
 * supplies ("Confirm"), so counting it would make every card look readable -- which is
 * what happened on the first draft of this function, and the contentless cards kept
 * their place at the front. Only `line` and `evidence` are the card's own words.
 */
export function answerable(need: Need): boolean {
  const readable = [need.line, ...need.evidence]
    .some((text) => text.trim().length > 0 && text.trim() !== FALLBACK_TEXT);
  return readable && need.options.length > 0;
}

/** What a card falls back to when it has no words of its own: the literal text the
 *  server's `confirmCard` writes into every confirm it mints. */
const FALLBACK_TEXT = 'confirm?';

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

/** What sits behind a question card's disclosure: which run is waiting on it, and
 *  whether anyone stands behind the options it offers. The question text itself is
 *  already the card's own line, so repeating it here would read as a stutter. */
function questionEvidence(card: Message): string[] {
  const lines: string[] = [];
  if (card.source && card.source !== 'system') lines.push(`Waiting: ${card.source}`);
  if (card.optionSource === 'drafted') lines.push('Options drafted, not the agent’s own');
  return lines;
}

/**
 * Everything that needs a person, in one ordered list: the blocker and confirm cards
 * off the thread response's second field (R-75 item 1), and every lane with an open
 * question. A lane the fleet already retired is not waiting on anyone.
 */
export function buildNeeds(lanes: Lane[], cards: Message[], blockers?: Blocker[]): Need[] {
  // A blocker card is built from a `blocker.raised` journal row and never carries its own
  // resolution, so blockers the fleet cleared days ago used to rank ahead of every real
  // question and inflate the counter. The Blockers slice is the authority on which are
  // still open. When it has not loaded, nothing is dropped: a card is never discarded on
  // a guess about state the console has not read yet.
  const openLanes = blockers === undefined ? null : new Set(
    blockers.filter((blocker) => blocker.state !== 'resolved').flatMap((blocker) => blocker.blocks.map((b) => b.laneId)),
  );
  const needs: Need[] = [];
  /** Ask keys already on the strip as a question card, so the lane pass below does not
   *  add the same ask a second time. Both come off the one inbox. */
  const questionKeys = new Set<string>();
  for (const card of cards) {
    if (card.resolved) continue;
    // R-75 shipped with the strip accepting `blocker` and `confirm` cards only. Every
    // open question reaches the console as a `question` card on the same list, so all
    // 92 of them were dropped on the floor: the strip is the console's answer to "what
    // needs me", and it was the one surface that never showed a question (measured
    // 2026-09-12). They were reachable on the Blockers screen and nowhere the strip
    // pointed.
    if (card.type === 'question') {
      const options = recommendedFirst(card.opts ?? [], card.recommended)
        .filter((option) => option.trim().length > 0);
      if (options.length === 0) continue;
      const key = card.askKey ?? card.k;
      questionKeys.add(key);
      needs.push({
        kind: 'question',
        uid: `card:${card.k}`,
        id: card.lane ?? card.source,
        key: '',
        title: card.kicker ?? 'Question',
        line: card.title ?? card.text,
        options: options.map((option) => ({ label: option, cmd: `answer ${key} ${option}` })),
        askKey: key,
        askedAt: card.ts,
        evidence: questionEvidence(card),
        passedTo: null,
        passedAt: null,
        answeredBy: null,
        passable: true,
      });
      continue;
    }
    if (card.type !== 'blocker' && card.type !== 'confirm') continue;
    if (card.type === 'blocker' && openLanes !== null && !openLanes.has(card.lane ?? card.source)) continue;
    const options: NeedOption[] = (card.btns ?? []).filter((button) => button.label.trim().length > 0).map((button) => ({ label: button.label, cmd: button.cmd }));
    needs.push({
      kind: card.type,
      uid: `card:${card.k}`,
      id: card.lane ?? card.source,
      // The kicker IS the head for a card ("Blocked · NWR-178"); repeating the headline
      // in both lines read as a stutter in the 2026-09-11 screenshot.
      key: '',
      // The blast is the card's own account of what the click will do -- "BBZ-182 is
      // killed immediately; its worktree and process are gone". A confirm card's `text`
      // is the constant `confirm?` every time, so reading `text` first put that string
      // in both lines and left the one sentence that says anything in the disclosure,
      // closed (2026-09-12). Prefer the words, fall back to the constant.
      title: card.kicker ?? (card.type === 'confirm' ? 'Confirm' : card.text),
      line: card.title ?? card.blast ?? card.text,
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
    // The same ask, already on the strip as a card. Both lists are built from the one
    // inbox, so an ask with a live lane behind it arrives twice.
    if (questionKeys.has(lane.question.key)) continue;
    const head = laneHeadline(lane);
    const question = lane.question;
    const opts = recommendedFirst(question.opts, question.recommended);
    needs.push({
      kind: 'lane',
      uid: `lane:${lane.id}:${question.key}`,
      id: lane.id,
      key: lane.ticket ?? '',
      title: lane.title?.trim() || head.main,
      line: question.text,
      options: opts.filter((option) => option.trim().length > 0).map((option) => ({ label: option, cmd: `answer ${question.key} ${option}` })),
      askKey: question.key,
      askedAt: question.askedAt,
      evidence: laneEvidence(lane),
      passedTo: question.passedTo ?? null,
      passedAt: question.passedAt ?? null,
      answeredBy: question.answeredBy ?? null,
      passable: true,
    });
  }
  // Answerable first, then worst-first inside each group, then oldest first. A card
  // nobody can answer never sits in front of one somebody can: that ordering is the
  // difference between a strip a person works through and a strip they give up on.
  needs.sort((a, b) => (Number(answerable(b)) - Number(answerable(a)))
    || (KIND_RANK[a.kind] - KIND_RANK[b.kind])
    || (a.askedAt - b.askedAt));
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
  // The card on screen is tracked by its OWN id, never by its position. A blocker
  // arriving on a poll sorts to the front and shifts every later card down a slot; with
  // a position, the reader's next keypress would answer whatever slid underneath them
  // (found by the 2026-09-11 critique).
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [passes, setPasses] = useState<Record<string, PassState>>({});
  const stripRef = useRef<HTMLElement | null>(null);
  /** Ask ids whose command is in the air, so a held key or a double click cannot post
   *  the same answer twice or skip the card behind it. */
  const inFlight = useRef<Set<string>>(new Set());

  const total = items.length;
  const found = currentId === null ? -1 : items.findIndex((item) => item.uid === currentId);
  // The tracked card is gone (answered, or the server closed it): fall back to the top
  // of the list, which is the worst thing still waiting.
  const at = found >= 0 ? found : 0;
  const need = items[at];

  const goTo = (next: number): void => {
    const target = items[Math.max(0, Math.min(total - 1, next))];
    setCurrentId(target ? target.uid : null);
  };

  const post = (target: Need, command: string): void => {
    if (inFlight.current.has(target.uid)) return;
    inFlight.current.add(target.uid);
    setPending((n) => n + 1);
    Promise.resolve(onCommand(target.id, command))
      .catch(() => undefined)
      .finally(() => {
        inFlight.current.delete(target.uid);
        setPending((n) => Math.max(0, n - 1));
      });
  };

  const answer = (target: Need, text: string): void => {
    if (inFlight.current.has(target.uid)) return;
    const option = target.options.find((o) => o.label === text);
    post(target, option ? option.cmd : `answer ${target.askKey} ${text}`);
    // Optimistic (spec §10): move on now, do not wait for the server.
    goTo(items.findIndex((item) => item.uid === target.uid) + 1);
  };

  const pass = (target: Need, name: string): void => {
    setPasses((map) => ({ ...map, [target.uid]: { name, pending: true, error: null } }));
    Promise.resolve(onCommand(target.id, `pass ${target.askKey} ${name}`))
      .then(() => setPasses((map) => ({ ...map, [target.uid]: { name, pending: false, error: null } })))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        // Rolled back: the card goes back to its options with the reason and a Retry.
        setPasses((map) => ({ ...map, [target.uid]: { name, pending: false, error: reason } }));
      });
  };

  // Number keys answer the card on screen. Bound on the document rather than on the
  // strip, so a reader does not have to click the strip first -- and skipped whenever
  // the keystroke belongs to something a person is typing in. Held through a ref so the
  // listener is subscribed once rather than on every clock tick.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event: KeyboardEvent): void => {
    if (!need || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
    // A sheet traps focus on its own buttons, which are none of the tags above, so a
    // digit pressed inside one used to answer and advance the strip behind it.
    if (document.querySelector('[data-testid="sheet-scrim"], dialog[open], [role="dialog"]')) return;
    // A card that is out with a teammate, or already answered by one, shows no options;
    // a key must not answer what the reader cannot see.
    const state = passes[need.uid];
    const passedTo = state?.error ? null : state?.name ?? need.passedTo;
    if (passedTo !== null || need.answeredBy !== null) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > KEYED_OPTIONS) return;
    const option = need.options[digit - 1];
    if (!option) return;
    event.preventDefault();
    answer(need, option.label);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => keyHandler.current(event);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const passState = passes[need.uid];
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
            onClick={() => goTo(at - 1)}
          >
            Previous
          </button>
          <span data-testid="needs-you-counter" style={{ fontVariantNumeric: 'tabular-nums' }}>{at + 1} of {total}</span>
          <button
            type="button" data-testid="needs-you-next" className="btn ghost" disabled={at >= total - 1}
            style={{ fontSize: 'var(--fs-meta)', padding: '2px 8px' }}
            onClick={() => goTo(at + 1)}
          >
            Next
          </button>
        </div>
      </div>
      <QuestionCard
        key={need.uid}
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
