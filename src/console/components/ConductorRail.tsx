import type { JSX } from 'react';
import { useStore } from '../store.js';
import { useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

import { computeFreshness, compactFreshnessStamp, freshnessClass, hm } from '../freshness.js';
import { actionable } from '../keyboard-actionable.js';
import { collapseRepeatedObservations } from '../laneVM.js';
import { StoreContext } from '../store.js';
import { Linkify } from './Linkify.js';
import type { Feed, Message } from '../../shared/console-model.js';

/** Chip label paired with the command it actually sends. The prototype's own
 *  `quick` list maps 'pause all' to the fuller 'pause everything' text, and both
 *  go through `send()`, so the chip click echoes an operator bubble just like
 *  typing it would. Order and text match the prototype exactly. */
export const QUICK_COMMANDS: [label: string, command: string][] = [
  ['pause all', 'pause everything'],
  ["what's stuck", "what's stuck"],
  ['spend today', 'spend today'],
  ['merge ready lanes', 'merge ready lanes'],
];

/** Item 14: a reply reads "Conductor" only when it actually came from one of
 *  these -- everything else (a worker's own run) names the run it came from. */
const CONDUCTOR_REPLY_SOURCES = new Set(['conductor', 'console', 'system']);

/** A line starting with `- ` in a reply or a refusal renders as a list item,
 *  and the rest of the text keeps the server's own line breaks (`whiteSpace:
 *  'pre-wrap'`) instead of collapsing a multi-line reply onto one line. */
function WrappedText({ text, repo }: { text: string; repo?: string | null }): JSX.Element {
  const lines = text.split('\n');
  const isList = lines.length > 1 && lines.some((line) => line.trimStart().startsWith('- '));
  if (!isList) return <div data-testid="wrapped-text" style={{ whiteSpace: 'pre-wrap' }}><Linkify text={text} repo={repo} /></div>;
  return (
    <div data-testid="wrapped-text" style={{ whiteSpace: 'pre-wrap' }}>
      {lines.map((line, i) => (
        line.trimStart().startsWith('- ')
          ? <div key={i} style={{ paddingLeft: 14, textIndent: -14 }}>• <Linkify text={line.trimStart().slice(2)} repo={repo} /></div>
          : <div key={i}><Linkify text={line} repo={repo} /></div>
      ))}
    </div>
  );
}

/** 2026-09-08: the rail has no lane of its own to read a repo off (a message may
 *  belong to any lane, or none) -- this resolves `message.lane`/`message.source`
 *  against the store's own lanes, and falls back to `links.defaultRepo`. */
function useMessageRepo(message: Message): string | null {
  // A card can render outside the store (a unit test, a sheet mounted on its own);
  // then there is no lane list to search and no default repo, and the text stays plain.
  const ctx = useContext(StoreContext);
  if (!ctx) return null;
  const { state } = ctx;
  const key = message.lane ?? message.source;
  const found = state.lanes.find((l) => l.id === key || l.ticket === key);
  return found?.repo ?? state.links.defaultRepo;
}

/** Exported so a lane-scoped thread (the ticket sheet) can render each message
 *  with the exact same per-type card the Conductor rail uses, rather than a
 *  second, drifting copy of this switch. */
export function MessageCard({
  message, feedLive, now, verbose = false, labelFor, replyLabel, onCommand, onUndo, onOpenJournal,
}: {
  message: Message; feedLive: boolean; now: number;
  /** 2026-09-08: plain by default. A `receipt`'s own jid text renders only in
   *  verbose mode; every other type is unaffected by this flag. */
  verbose?: boolean;
  /** A person's name for a lane id, used by a `question` card's own header
   *  ("Question from <label>"). Falls back to the raw source id when unset or
   *  when it knows nothing about that particular id. */
  labelFor?: (id: string) => string | null;
  /** Item 6: overrides a `reply` card's own label outright, skipping `labelFor`
   *  entirely -- the ticket sheet passes `'Worker'`, since every reply inside a run's
   *  own thread is that run's own report and `labelFor` there resolves to the lane's
   *  whole title (the live sheet's own bug: a report labelled in capitals with the
   *  lane's title). The board-wide rail leaves this unset and keeps `labelFor(source)`,
   *  since a rail mixes replies from many different runs. */
  replyLabel?: string;
  onCommand: (text: string) => void; onUndo: (jid: string) => void; onOpenJournal: (jid: string) => void;
}): JSX.Element {
  const [free, setFree] = useState('');
  const [showTip, setShowTip] = useState(false);
  // Every message carries a stamp: verifiedAt falls back to the message's own
  // ts (an "observed" reading) rather than suppressing the stamp when a seeded
  // fixture omits verifiedAt.
  const fresh = computeFreshness(message.verifiedAt ?? null, message.ts, feedLive, now);
  const repo = useMessageRepo(message);

  switch (message.type) {
    // Item 7: a plain-mode digest of a run's own tool calls reads as a quiet
    // mono line with no chip border, not another all-caps chip.
    case 'activity':
      return (
        <div className="m" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-meta)', color: 'var(--ink3)', minWidth: 0, overflowWrap: 'anywhere' }}>
          <span><Linkify text={message.text} repo={repo} /></span>
          <span className={freshnessClass(fresh)}>{compactFreshnessStamp(fresh)}</span>
        </div>
      );
    case 'event':
      return (
        <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            className="chip"
            style={{ borderColor: 'var(--ink2)', color: 'var(--ink2)', whiteSpace: 'normal', textTransform: 'none', letterSpacing: 'normal' }}
          >
            <Linkify text={message.text} repo={repo} />
          </span>
          <span className={freshnessClass(fresh)}>{compactFreshnessStamp(fresh)}</span>
        </div>
      );
    case 'operator':
      return (
        <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--ink)', color: 'var(--bg)', padding: '9px 13px', borderRadius: '10px 10px 3px 10px', font: 'var(--fs-body)/1.5 "IBM Plex Sans",sans-serif', overflowWrap: 'anywhere' }}>
          <Linkify text={message.text} repo={repo} />
        </div>
      );
    case 'reply': {
      // Item 14: every reply used to say "Conductor", including a worker's own
      // root-cause report inside its run thread -- a reply is labeled that only
      // when it actually came from the conductor/console/system; anything else
      // names the run it came from (or "Worker" when nothing can name it).
      // 2026-09-08: a rail reply names the path that answered it, so a grammar
      // fallback never reads as the agent having spoken.
      const conductorLabel = message.path === 'grammar' ? 'Conductor (grammar)' : 'Conductor';
      const replySource = replyLabel
        ?? (CONDUCTOR_REPLY_SOURCES.has(message.source) ? conductorLabel : (labelFor?.(message.source) ?? 'Worker'));
      return (
        <div style={{ maxWidth: '92%' }}>
          <div className="lbl" data-testid="reply-label" style={{ color: 'var(--ink3)', marginBottom: 3 }}>{replySource}</div>
          <div style={{ borderLeft: '2px solid var(--line2)', paddingLeft: 10, font: 'var(--fs-body)/1.5 "IBM Plex Sans",sans-serif', overflowWrap: 'anywhere' }}>
            <WrappedText text={message.text} repo={repo} />
          </div>
          {message.btns && message.btns.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, margin: '8px 0 0 12px', flexWrap: 'wrap' }}>
              {message.btns.map((b) => (
                <span key={b.label} className={b.cls === 'destroy' ? 'btnR' : b.cls === 'answer' ? 'btnA' : b.cls === 'defer' ? 'btnS' : 'btnP'} style={{ padding: '6px 10px', fontSize: 'var(--fs-ui)' }} {...actionable(() => onCommand(b.cmd))}>
                  {b.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    case 'refusal':
      return (
        <div style={{ maxWidth: '88%', border: '1px dashed var(--block)', borderLeft: '3px solid var(--block)', borderRadius: 4, padding: '9px 12px' }}>
          <div className="lbl" style={{ color: 'var(--block)', marginBottom: 3 }}>Refused</div>
          <div style={{ font: 'var(--fs-body)/1.5 "IBM Plex Sans",sans-serif', color: 'var(--ink2)', overflowWrap: 'anywhere' }}>
            <WrappedText text={message.text} repo={repo} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span className="lbl" data-testid="conductor-working" style={{ color: 'var(--ink3)' }}>{message.text || 'conductor is planning'}</span>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite' }} />
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite .2s' }} />
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite .4s' }} />
        </div>
      );
    case 'receipt': {
      const tip = showTip ? (
        <span className="tip" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {hm(message.ts)} · {message.source} · {message.text}{message.undoable && !message.undone ? ' · reversible, undo 24h' : ''}
        </span>
      ) : null;
      return (
        <div className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0, overflowWrap: 'anywhere', textDecoration: message.undone ? 'line-through' : 'none' }}>
          {verbose && message.jid ? (
            <a
              data-testid="receipt-jid"
              style={{ fontWeight: 700, color: 'var(--ink)', cursor: 'pointer', position: 'relative' }}
              {...actionable(() => onOpenJournal(message.jid as string))}
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
            >
              {message.jid}
              {tip}
            </a>
          ) : null}
          {/* Item 13: plain mode showed the jid link with no text at all -- a link
              rendered with nothing visible in it, reading as a stray dash sitting
              above every receipt. Plain mode renders no anchor here at all; the
              receipt's own sentence carries the click target and the hover
              tooltip instead, and the undo link (below) is unaffected either way. */}
          <span
            data-testid={!verbose && message.jid ? 'receipt-jid' : undefined}
            style={message.jid ? { position: 'relative', cursor: 'pointer' } : undefined}
            {...(!verbose && message.jid ? actionable(() => onOpenJournal(message.jid as string)) : {})}
            onMouseEnter={() => { if (!verbose && message.jid) setShowTip(true); }}
            onMouseLeave={() => { if (!verbose) setShowTip(false); }}
          >
            <Linkify text={message.text} repo={repo} />
            {!verbose ? tip : null}
          </span>
          {message.undoable && !message.undone && message.jid ? <a style={{ fontWeight: 600 }} {...actionable(() => onUndo(message.jid as string))}>undo</a> : null}
          <span className={freshnessClass(fresh)}>{compactFreshnessStamp(fresh)}</span>
        </div>
      );
    }
    case 'plan':
      return (
        <div className="plate" style={{ maxWidth: '94%' }}>
          <div className="lbl" style={{ padding: '7px 12px', borderBottom: '1px solid var(--line)', color: 'var(--ink2)', display: 'flex', justifyContent: 'space-between' }}>
            <span>Plan · {message.items?.length ?? 0} actions</span>
            <span>{message.resolved ?? 'awaiting go'}</span>
          </div>
          <div style={{ padding: '4px 0' }}>
            {message.items?.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 12px' }}>
                <span className="m" style={{ fontSize: 'var(--fs-meta)', fontWeight: 700, color: 'var(--ink3)' }}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, font: 'var(--fs-body)/1.45 "IBM Plex Sans",sans-serif', overflowWrap: 'anywhere' }}><Linkify text={a.text} repo={repo} /></span>
                <span
                  className="chip"
                  style={{
                    borderColor: a.irreversible ? 'var(--block)' : 'var(--run)',
                    background: a.irreversible ? 'var(--block)' : 'transparent',
                    color: a.irreversible ? 'var(--aInk)' : 'var(--run)',
                  }}
                >
                  {a.irreversible ? 'irreversible' : 'reversible'}
                </span>
              </div>
            ))}
          </div>
          {!message.resolved ? (
            <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
              {message.btns && message.btns.length > 0 ? (
                message.btns.map((b) => (
                  <span key={b.label} className={b.cls === 'go' ? 'btnP' : 'btnS'} {...actionable(() => onCommand(b.cmd))}>
                    {b.label}{b.cls === 'go' ? ' →' : ''}
                  </span>
                ))
              ) : (
                <>
                  <span className="btnP" {...actionable(() => onCommand(`run ${message.k}`))}>Run plan →</span>
                  <span className="btnS" {...actionable(() => onCommand(`dismiss ${message.k}`))}>Not now</span>
                </>
              )}
            </div>
          ) : null}
        </div>
      );
    case 'confirm':
      return (
        <div style={{ border: '2px solid var(--block)', borderRadius: 4, maxWidth: '94%' }}>
          <div className="lbl" style={{ background: 'var(--block)', color: 'var(--aInk)', padding: '7px 12px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Confirm — irreversible</span>
            <span>{message.resolved ?? 'awaiting you'}</span>
          </div>
          <div style={{ padding: '11px 12px', font: 'var(--fs-body)/1.5 "IBM Plex Sans",sans-serif', overflowWrap: 'anywhere' }}>
            <Linkify text={message.text} repo={repo} /> <strong>{message.blast}</strong>
          </div>
          {!message.resolved ? (
            <div style={{ display: 'flex', gap: 10, padding: '0 12px 12px' }}>
              {message.btns && message.btns.length > 0 ? (
                message.btns.map((b) => (
                  <span key={b.label} className={b.cls === 'destroy' ? 'btnR' : 'btnS'} {...actionable(() => onCommand(b.cmd))}>
                    {b.label}
                  </span>
                ))
              ) : (
                <>
                  <span className="btnR" {...actionable(() => onCommand(`confirm ${message.k}`))}>Confirm</span>
                  <span className="btnS" {...actionable(() => onCommand(`decline ${message.k}`))}>Not now</span>
                </>
              )}
            </div>
          ) : null}
        </div>
      );
    case 'question':
      return (
        <div style={{ border: '1px solid var(--hand)', borderRadius: 4, maxWidth: '94%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--line)' }}>
            <span className="lbl" style={{ color: 'var(--hand)' }}>Question · from <Linkify text={labelFor?.(message.source) ?? message.source} repo={repo} /></span>
            <span className={freshnessClass(fresh)}>{compactFreshnessStamp(fresh)}</span>
          </div>
          <div style={{ padding: '10px 12px', font: 'var(--fs-body)/1.5 "IBM Plex Sans",sans-serif', overflowWrap: 'anywhere' }}><Linkify text={message.text} repo={repo} /></div>
          {!message.text.trim() ? (
            <>
              <div className="m" style={{ padding: '0 12px 10px', fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>This run asked for something but sent no question</div>
              <div style={{ display: 'flex', gap: 8, padding: '0 12px 10px' }}>
                <span className="btnS" {...actionable(() => onCommand(`dismiss ${message.askKey ?? ''}`))}>Dismiss</span>
                <span className="btnS" {...actionable(() => onCommand(`resume ${message.lane ?? message.source}`))}>Resume</span>
              </div>
            </>
          ) : message.answer === undefined ? (
            <>
              {/* One option per row, full width, text wrapping: an option is a sentence a
                 worker wrote, and a no-wrap pill ran off the rail (2026-09-08). */}
              <div data-testid="question-options" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 10px' }}>
                {message.opts?.map((o, i) => {
                  const recommended = message.recommended === i;
                  return (
                    <span
                      key={o} className="btnA" data-recommended={recommended || undefined}
                      style={{ padding: '7px 10px', fontSize: 'var(--fs-ui)', textAlign: 'left', justifyContent: 'flex-start', lineHeight: 1.35, letterSpacing: 0.3, textTransform: 'none', display: 'flex', gap: 8, alignItems: 'baseline' }}
                      {...actionable(() => onCommand(`answer ${message.askKey ?? ''} ${o}`))}
                    >
                      <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', width: '100%' }}>{o}</span>
                      {recommended ? <span className="stO" style={{ color: 'var(--run)' }}>Recommended</span> : null}
                    </span>
                  );
                })}
              </div>
              <div style={{ margin: '0 12px 12px', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '7px 10px', display: 'flex' }}>
                <input
                  className="inp m" style={{ fontSize: 'var(--fs-ui)' }} placeholder="or type an answer, ⏎"
                  value={free} onChange={(e) => setFree(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && free.trim()) { onCommand(`answer ${message.askKey ?? ''} ${free}`); setFree(''); } }}
                />
              </div>
            </>
          ) : (
            <div className="m" style={{ padding: '0 12px 10px', fontSize: 'var(--fs-meta)', color: 'var(--run)' }}>answered: {message.answer}</div>
          )}
        </div>
      );
    case 'pr':
      return (
        <div className="plate" style={{ maxWidth: '94%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', gap: 12 }}>
          <div>
            <div className="lbl" style={{ color: 'var(--merge)', marginBottom: 3 }}>Draft PR · {message.source}</div>
            <a className="m" style={{ fontSize: 'var(--fs-body)', fontWeight: 700, overflowWrap: 'anywhere' }} href={message.pr?.url}>{message.text} ↗</a>
          </div>
          <span className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 'none' }}>
            {message.pr?.files ?? 0} files · <span style={{ color: 'var(--run)', fontWeight: 700 }}>+{message.pr?.add ?? 0}</span> <span style={{ color: 'var(--block)', fontWeight: 700 }}>−{message.pr?.del ?? 0}</span>
          </span>
        </div>
      );
    default:
      return <div><Linkify text={message.text} repo={repo} /></div>;
  }
}

export interface ConductorRailProps {
  thread: Message[];
  feed: Feed;
  now: number;
  composer: string;
  onComposerChange: (text: string) => void;
  /** Typed composer text and quick-command chips go through the prototype's own
   *  `send()`, so both echo an operator bubble before the command runs. */
  onSend: (text: string) => void;
  /** Reply, plan, confirm, and question buttons, plus a question's free-text answer,
   *  wire straight to `act()` / `answer()` / `runPlan()` in the prototype, bypassing
   *  `send()` entirely, so clicking one never echoes a fake operator bubble. */
  onCommand: (text: string) => void;
  onUndo: (jid: string) => void;
  onOpenJournal: (jid: string) => void;
  /** 2026-09-08: plain by default -- see `MessageCard`'s own doc. */
  verbose?: boolean;
  labelFor?: (id: string) => string | null;
}

/** Right rail, single thread; composer disabled with a reason banner when the feed is down. */
/** How close to the bottom, in pixels, still counts as reading the newest message. */
const PINNED_SLACK_PX = 24;

/**
 * Chat scrolling for the thread. The list opens pinned to its newest message and stays
 * pinned as messages arrive; the moment the reader scrolls up it holds still, counts
 * what lands below, and offers a pill that jumps back down. Scrolling to the bottom by
 * hand re-pins. Measured off the scroll container itself, never off React state, so a
 * message that arrives mid-scroll cannot be mistaken for the reader letting go.
 */
function useChatScroll(messageCount: number, newestKey: string | undefined): {
  ref: React.RefObject<HTMLDivElement | null>; unread: number; onScroll: () => void; jump: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const [unread, setUnread] = useState(0);
  const lastCount = useRef(messageCount);

  const isAtBottom = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_SLACK_PX;

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnread(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = isAtBottom(el);
    pinned.current = atBottom;
    if (atBottom) setUnread(0);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const arrived = Math.max(0, messageCount - lastCount.current);
    lastCount.current = messageCount;
    if (!el) return;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    } else if (arrived > 0) {
      setUnread((n) => n + arrived);
    }
  }, [messageCount, newestKey]);

  return { ref, unread, onScroll, jump };
}

/** W5: the machinery, never the conversation -- an `event` chip or an `activity`
 *  digest is a run's own tool noise, not something a person asked for or said.
 *  Everything else (operator/reply/question/plan/confirm/receipt/refusal/pr/thinking)
 *  is a conversation row and stays in the rail proper. */
function isObservation(m: Message): boolean {
  return m.type === 'event' || m.type === 'activity';
}

export function ConductorRail(props: ConductorRailProps): JSX.Element {
  const { thread, feed, now, composer, verbose = false, labelFor, onComposerChange, onSend, onCommand, onUndo, onOpenJournal } = props;
  // The composer's own action state (`App.tsx#processCommand` keys it `sendCommand:rail`):
  // a working row within one render of Send, and the send control held while the
  // grammar answers. The reply cards are the inline result and land in the thread.
  const composerAction = useStore().state.actions['sendCommand:rail'];
  const composerBusy = composerAction?.pending ?? false;
  // W5: the rail thread is conversation only -- every `event`/`activity` row moves to
  // the Activity drawer below, closed by default. The badge counts the raw rows the
  // fleet actually logged; the drawer's own open body folds repeats (a warden tick
  // storm, the same Jira write logged once per worker) into one line with a count.
  const observationRows = thread.filter(isObservation);
  const conversation = thread.filter((m) => !isObservation(m));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const collapsedObservations = collapseRepeatedObservations(observationRows);
  const scroll = useChatScroll(conversation.length, conversation.at(-1)?.k);
  const isPending = (m: Message): boolean => (
    (m.type === 'question' && m.answer === undefined)
    || (m.type === 'confirm' && m.resolved === undefined)
    || (m.type === 'plan' && m.resolved === undefined)
  );
  const pendingMessages = thread.filter(isPending);
  const pending = pendingMessages.length;
  // Sweep #13: "N waiting" named nothing to jump to -- the oldest unresolved card is
  // the one already first in the thread's own append order, since a card resolves
  // itself in place rather than moving.
  const oldestPendingKey = pendingMessages[0]?.k;
  return (
    <div style={{ width: 'clamp(360px, 30vw, 480px)', flex: 'none', borderLeft: '2px solid var(--line2)', display: 'flex', flexDirection: 'column', background: 'var(--panel)', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <span className="lbl">Conductor</span>
        <span
          className="m"
          style={{ fontSize: 'var(--fs-meta)', fontWeight: 700, color: 'var(--block)', cursor: pending > 0 ? 'pointer' : 'default' }}
          {...actionable(() => {
            if (!oldestPendingKey) return;
            document.getElementById(`rail-msg-${oldestPendingKey}`)?.scrollIntoView({ block: 'center' });
          })}
        >
          {pending > 0 ? `${pending} waiting ↓` : ''}
        </span>
      </div>
      {observationRows.length > 0 ? (
        <div data-testid="activity-drawer" style={{ margin: '10px 16px 0', border: '1px solid var(--line)', borderRadius: 4, flex: 'none' }} {...actionable(() => setDrawerOpen((open) => !open))}>
          <div className="lbl" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', color: 'var(--ink3)' }}>
            <span>Activity {drawerOpen ? '▾' : '▸'}</span>
            <span data-testid="activity-drawer-badge">{observationRows.length}</span>
          </div>
          {drawerOpen ? (
            <div data-testid="activity-drawer-body" style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--line)' }}>
              {collapsedObservations.map((m) => (
                <div key={m.k} className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', overflowWrap: 'anywhere' }}>
                  {m.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="scroll" data-testid="rail-thread" style={{ flex: 1, minHeight: 0, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, opacity: feed.live ? 1 : 0.6 }}>
        {conversation.map((m) => (
          <div key={m.k} id={`rail-msg-${m.k}`}>
            <MessageCard message={m} feedLive={feed.live} now={now} verbose={verbose} labelFor={labelFor} onCommand={onCommand} onUndo={onUndo} onOpenJournal={onOpenJournal} />
          </div>
        ))}
      </div>
      {scroll.unread > 0 ? (
        <span
          className="chip chipB chipOn"
          data-testid="rail-jump"
          style={{ position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', boxShadow: '0 2px 8px rgba(0,0,0,.45)' }}
          {...actionable(scroll.jump)}
        >
          {scroll.unread} new ↓
        </span>
      ) : null}
      </div>
      {feed.live ? (
        <>
          <div style={{ margin: '0 16px 8px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {QUICK_COMMANDS.map(([label, command]) => (
              <span key={label} className="chip chipB" {...actionable(() => onSend(command))}>{label}</span>
            ))}
          </div>
          <div style={{ margin: '0 16px 16px', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 8px 8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="inp" placeholder="command… e.g. why is lane 3 stuck" value={composer}
              onChange={(e) => onComposerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && composer.trim() && !composerBusy) { onSend(composer); onComposerChange(''); } }}
            />
            <span
              className="btnP" style={{ padding: '5px 10px', fontSize: 'var(--fs-ui)', opacity: composerBusy ? 0.55 : 1 }}
              aria-busy={composerBusy} aria-disabled={composerBusy} data-testid="action-sendCommand-rail" data-pending={composerBusy ? 'true' : 'false'}
              {...actionable(() => { if (composer.trim() && !composerBusy) { onSend(composer); onComposerChange(''); } })}
            >
              {composerBusy ? 'Working…' : 'Send ⏎'}
            </span>
          </div>
          {composerBusy ? (
            <div className="m" data-testid="rail-working" style={{ margin: '-8px 16px 12px', fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>working…</div>
          ) : composerAction?.result?.kind === 'done' && !composerAction.result.ok ? (
            <div className="m" data-testid="rail-composer-result" style={{ margin: '-8px 16px 12px', fontSize: 'var(--fs-meta)', color: 'var(--block)' }}>✕ {composerAction.result.text}</div>
          ) : null}
        </>
      ) : (
        <div className="lbl" style={{ margin: '0 16px 16px', background: 'var(--block)', color: 'var(--aInk)', borderRadius: 3, padding: '12px 14px', lineHeight: 1.8, letterSpacing: '.8px' }}>
          Composer disabled · feed disconnected ({feed.reason ?? 'unknown'}) · commands resume when feed returns
        </div>
      )}
    </div>
  );
}
