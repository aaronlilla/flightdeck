import type { JSX } from 'react';
import { useState } from 'react';

import { computeFreshness, freshnessClass, freshnessStamp, hm } from '../freshness.js';
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
const MAX_VISIBLE_MESSAGES = 200;

export interface CollapsedMessage extends Message {
  /** Set once a run of identical consecutive conductor replies collapses into one card. */
  collapsedCount?: number;
}

/** A run of identical consecutive `reply` cards from the conductor becomes one card
 *  with a `×N` count -- every other message type, and any reply that differs from
 *  its predecessor, passes through untouched. */
export function collapseReplies(thread: Message[]): CollapsedMessage[] {
  const out: CollapsedMessage[] = [];
  for (const m of thread) {
    const prev = out[out.length - 1];
    if (m.type === 'reply' && prev?.type === 'reply' && prev.text === m.text && prev.source === m.source) {
      prev.collapsedCount = (prev.collapsedCount ?? 1) + 1;
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/** Exported so a lane-scoped thread (the ticket sheet) can render each message
 *  with the exact same per-type card the Conductor rail uses, rather than a
 *  second, drifting copy of this switch. */
export function MessageCard({
  message, feedLive, now, onCommand, onUndo, onOpenJournal,
}: { message: CollapsedMessage; feedLive: boolean; now: number; onCommand: (text: string) => void; onUndo: (jid: string) => void; onOpenJournal: (jid: string) => void }): JSX.Element {
  const [free, setFree] = useState('');
  const [showTip, setShowTip] = useState(false);
  // Every message carries a stamp: verifiedAt falls back to the message's own
  // ts (an "observed" reading) rather than suppressing the stamp when a seeded
  // fixture omits verifiedAt.
  const fresh = computeFreshness(message.verifiedAt ?? null, message.ts, feedLive, now);

  switch (message.type) {
    case 'event':
      return (
        <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="chip" style={{ borderColor: 'var(--ink2)', color: 'var(--ink2)' }}>{message.text}</span>
          <span className={freshnessClass(fresh)}>{freshnessStamp(fresh)}</span>
        </div>
      );
    case 'operator':
      return (
        <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--ink)', color: 'var(--bg)', padding: '9px 13px', borderRadius: '10px 10px 3px 10px', font: '13px/1.45 "IBM Plex Sans",sans-serif' }}>
          {message.text}
        </div>
      );
    case 'reply':
      return (
        <div style={{ maxWidth: '92%' }}>
          <div className="lbl" style={{ color: 'var(--ink3)', marginBottom: 3 }}>Conductor</div>
          <div style={{ borderLeft: '2px solid var(--line2)', paddingLeft: 10, font: '13px/1.5 "IBM Plex Sans",sans-serif' }}>
            {message.text}{message.collapsedCount && message.collapsedCount > 1 ? ` ×${message.collapsedCount}` : ''}
          </div>
          {message.btns && message.btns.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, margin: '8px 0 0 12px', flexWrap: 'wrap' }}>
              {message.btns.map((b) => (
                <span key={b.label} className={b.cls === 'destroy' ? 'btnR' : b.cls === 'answer' ? 'btnA' : b.cls === 'defer' ? 'btnS' : 'btnP'} style={{ padding: '6px 10px', fontSize: '9.5px' }} onClick={() => onCommand(b.cmd)}>
                  {b.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      );
    case 'refusal':
      return (
        <div style={{ maxWidth: '88%', border: '1px dashed var(--block)', borderLeft: '3px solid var(--block)', borderRadius: 4, padding: '9px 12px' }}>
          <div className="lbl" style={{ color: 'var(--block)', marginBottom: 3 }}>Refused</div>
          <div style={{ font: '13px/1.5 "IBM Plex Sans",sans-serif', color: 'var(--ink2)' }}>{message.text}</div>
        </div>
      );
    case 'thinking':
      return (
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span className="lbl" style={{ color: 'var(--ink3)' }}>conductor is planning</span>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite' }} />
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite .2s' }} />
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink3)', animation: 'fddot 1.2s infinite .4s' }} />
        </div>
      );
    case 'receipt':
      return (
        <div className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', textDecoration: message.undone ? 'line-through' : 'none' }}>
          {message.jid ? (
            <a
              style={{ fontWeight: 700, color: 'var(--ink)', cursor: 'pointer', position: 'relative' }}
              onClick={() => onOpenJournal(message.jid as string)}
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
            >
              {message.jid}
              {showTip ? (
                <span className="tip" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1, whiteSpace: 'nowrap' }}>
                  {hm(message.ts)} · {message.source} · {message.text}{message.undoable && !message.undone ? ' · reversible, undo 24h' : ''}
                </span>
              ) : null}
            </a>
          ) : null}
          <span>{message.text}</span>
          {message.undoable && !message.undone && message.jid ? <a style={{ fontWeight: 600 }} onClick={() => onUndo(message.jid as string)}>undo</a> : null}
          <span className={freshnessClass(fresh)}>{freshnessStamp(fresh)}</span>
        </div>
      );
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
                <span className="m" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink3)' }}>{i + 1}</span>
                <span style={{ flex: 1, font: '12.5px/1.4 "IBM Plex Sans",sans-serif' }}>{a.text}</span>
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
              <span className="btnP" onClick={() => onCommand(`run ${message.k}`)}>Run plan →</span>
              <span className="btnS" onClick={() => onCommand(`dismiss ${message.k}`)}>Not now</span>
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
          <div style={{ padding: '11px 12px', font: '13px/1.5 "IBM Plex Sans",sans-serif' }}>
            {message.text} <strong>{message.blast}</strong>
          </div>
          {!message.resolved ? (
            <div style={{ display: 'flex', gap: 10, padding: '0 12px 12px' }}>
              <span className="btnR" onClick={() => onCommand(`confirm ${message.k}`)}>Confirm</span>
              <span className="btnS" onClick={() => onCommand(`decline ${message.k}`)}>Not now</span>
            </div>
          ) : null}
        </div>
      );
    case 'question':
      return (
        <div style={{ border: '1px solid var(--hand)', borderRadius: 4, maxWidth: '94%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--line)' }}>
            <span className="lbl" style={{ color: 'var(--hand)' }}>Question · from {message.source}</span>
            <span className={freshnessClass(fresh)}>{freshnessStamp(fresh)}</span>
          </div>
          <div style={{ padding: '10px 12px', font: '13px/1.5 "IBM Plex Sans",sans-serif' }}>{message.text}</div>
          {message.answer === undefined ? (
            <>
              <div style={{ display: 'flex', gap: 6, padding: '0 12px 10px', flexWrap: 'wrap' }}>
                {message.opts?.map((o) => (
                  <span key={o} className="btnA" style={{ padding: '6px 10px', fontSize: '9.5px' }} onClick={() => onCommand(`answer ${message.askKey ?? ''} ${o}`)}>
                    {o}
                  </span>
                ))}
              </div>
              <div style={{ margin: '0 12px 12px', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '7px 10px', display: 'flex' }}>
                <input
                  className="inp m" style={{ fontSize: 11 }} placeholder="or type an answer, ⏎"
                  value={free} onChange={(e) => setFree(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && free.trim()) { onCommand(`answer ${message.askKey ?? ''} ${free}`); setFree(''); } }}
                />
              </div>
            </>
          ) : (
            <div className="m" style={{ padding: '0 12px 10px', fontSize: '10.5px', color: 'var(--run)' }}>answered: {message.answer}</div>
          )}
        </div>
      );
    case 'pr':
      return (
        <div className="plate" style={{ maxWidth: '94%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', gap: 12 }}>
          <div>
            <div className="lbl" style={{ color: 'var(--merge)', marginBottom: 3 }}>Draft PR · {message.source}</div>
            <a className="m" style={{ fontSize: '11.5px', fontWeight: 700 }} href={message.pr?.url}>{message.text} ↗</a>
          </div>
          <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', whiteSpace: 'nowrap' }}>
            {message.pr?.files ?? 0} files · <span style={{ color: 'var(--run)', fontWeight: 700 }}>+{message.pr?.add ?? 0}</span> <span style={{ color: 'var(--block)', fontWeight: 700 }}>−{message.pr?.del ?? 0}</span>
          </span>
        </div>
      );
    default:
      return <div>{message.text}</div>;
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
}

/** Right rail, single thread; composer disabled with a reason banner when the feed is down. */
export function ConductorRail(props: ConductorRailProps): JSX.Element {
  const { thread, feed, now, composer, onComposerChange, onSend, onCommand, onUndo, onOpenJournal } = props;
  const [showEarlier, setShowEarlier] = useState(false);
  const pending = thread.filter((m) => (
    (m.type === 'question' && m.answer === undefined)
    || (m.type === 'confirm' && m.resolved === undefined)
    || (m.type === 'plan' && m.resolved === undefined)
  )).length;
  const collapsed = collapseReplies(thread);
  const hiddenCount = Math.max(0, collapsed.length - MAX_VISIBLE_MESSAGES);
  const visible = showEarlier || hiddenCount === 0 ? collapsed : collapsed.slice(-MAX_VISIBLE_MESSAGES);
  return (
    <div style={{ width: 'clamp(300px,30vw,390px)', flex: 'none', borderLeft: '2px solid var(--line2)', display: 'flex', flexDirection: 'column', background: 'var(--panel)', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <span className="lbl">Conductor</span>
        <span className="m" style={{ fontSize: 10, fontWeight: 700, color: 'var(--block)' }}>{pending > 0 ? `${pending} waiting ↓` : ''}</span>
      </div>
      <div className="scroll" data-testid="rail-thread" style={{ flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, opacity: feed.live ? 1 : 0.6 }}>
        {hiddenCount > 0 && !showEarlier ? (
          <a className="m" style={{ alignSelf: 'center', fontSize: '10.5px', color: 'var(--ink3)' }} onClick={() => setShowEarlier(true)}>
            show earlier ({hiddenCount})
          </a>
        ) : null}
        {visible.map((m) => (
          <MessageCard key={m.k} message={m} feedLive={feed.live} now={now} onCommand={onCommand} onUndo={onUndo} onOpenJournal={onOpenJournal} />
        ))}
      </div>
      {feed.live ? (
        <>
          <div style={{ margin: '0 16px 8px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {QUICK_COMMANDS.map(([label, command]) => (
              <span key={label} className="chip chipB" onClick={() => onSend(command)}>{label}</span>
            ))}
          </div>
          <div style={{ margin: '0 16px 16px', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 8px 8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="inp" placeholder="command… e.g. why is lane 3 stuck" value={composer}
              onChange={(e) => onComposerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && composer.trim()) { onSend(composer); onComposerChange(''); } }}
            />
            <span className="btnP" style={{ padding: '5px 10px', fontSize: '9.5px' }} onClick={() => { if (composer.trim()) { onSend(composer); onComposerChange(''); } }}>Send ⏎</span>
          </div>
        </>
      ) : (
        <div className="lbl" style={{ margin: '0 16px 16px', background: 'var(--block)', color: 'var(--aInk)', borderRadius: 3, padding: '12px 14px', lineHeight: 1.8, letterSpacing: '.8px' }}>
          Composer disabled · feed disconnected ({feed.reason ?? 'unknown'}) · commands resume when feed returns
        </div>
      )}
    </div>
  );
}
