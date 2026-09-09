import type { JSX } from 'react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';

import { hm } from '../freshness.js';
import { useStore } from '../store.js';
import type { Feed, Message, MessageButton } from '../../shared/console-model.js';
import { Marks, QuestionCard } from './QuestionCard.js';

/**
 * `FD Rail.dc.html`: the Conductor rail. Rows by kind (status, receipt with Undo,
 * operator, the agent's own words, the question card, action cards with kicker, title,
 * body, meta table and stacked buttons, and the tool-call disclosure), then the command
 * chips, the topic row with its Conductor / agent switch, and the composer.
 */
export interface RailCommand {
  label: string;
  /** Sent through `onSend` as typed text, or handled by the page when it starts with
   *  `open ` (a view or a lane). */
  cmd: string;
}

export interface ConductorRailProps {
  thread: Message[];
  feed: Feed;
  now: number;
  composer: string;
  onComposerChange: (text: string) => void;
  /** Typed text and chips. `toLane` is set when the recipient switch points at the
   *  agent working the topic lane. */
  onSend: (text: string, toLane?: string) => void;
  /** A card button's own command, a question's answer. */
  onCommand: (text: string) => void;
  onUndo: (jid: string) => void;
  onOpenJournal?: (jid: string) => void;
  labelFor?: (id: string) => string | null;
  /** Active lanes right now; the header reads "N agents · live". */
  agentCount?: number;
  topic?: { id: string; label: string } | null;
  recipient?: 'conductor' | 'agent';
  onRecipient?: (recipient: 'conductor' | 'agent') => void;
  onTopic?: (laneId: string | null) => void;
  commands?: RailCommand[];
  onStop?: () => void;
  verbose?: boolean;
}

const CONDUCTOR_SOURCES = new Set(['conductor', 'console', 'system', 'operator']);

export const DEFAULT_COMMANDS: RailCommand[] = [
  { label: "What's stuck?", cmd: "what's stuck" },
  { label: "Merge what's ready", cmd: 'merge ready lanes' },
  { label: 'Pause everything', cmd: 'pause everything' },
  { label: 'Spend today', cmd: 'spend today' },
];

type Tone = 'warn' | 'acc' | 'neutral';
const TONE: Record<Tone, [string, string]> = { warn: ['var(--warn)', 'var(--warnTint)'], acc: ['var(--acc)', 'transparent'], neutral: ['var(--ink2)', 'transparent'] };

function buttonClass(button: MessageButton): string {
  switch (button.cls) {
    case 'go': case 'destroy': return 'btn primary';
    case 'answer': return 'btn warn';
    case 'defer': return 'btn ghost';
    default: return 'btn';
  }
}

function Stamp({ ts }: { ts: number }): JSX.Element {
  return <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums' }}>{hm(ts)}</span>;
}

function Row({ ts, children }: { ts: number; children: JSX.Element }): JSX.Element {
  return <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: 8, alignItems: 'baseline' }}><Stamp ts={ts} />{children}</div>;
}

/** An action card: a confirm, a plan, a blocker with a choice, a decision, a refusal. */
function ActionCard({ message, tone, kicker, title, body, onCommand, onTopic, composerId }: {
  message: Message; tone: Tone; kicker: string; title: string; body: string;
  onCommand: (text: string) => void; onTopic?: (laneId: string) => void; composerId?: string;
}): JSX.Element {
  const [color, ground] = TONE[tone];
  const lane = message.lane ?? (CONDUCTOR_SOURCES.has(message.source) ? null : message.source);
  const resolved = message.resolved;
  const asks = Boolean(message.btns && message.btns.length > 0 && !resolved);
  return (
    <div data-testid={asks ? 'question-card' : `card-${message.type}`} data-card={message.type} style={{ position: 'relative', marginLeft: 48, border: `1px solid ${color}`, background: ground, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Marks />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="kick" style={{ color, fontWeight: 700, minWidth: 0, cursor: lane && onTopic ? 'pointer' : undefined }} onClick={() => { if (lane && onTopic) onTopic(lane); }}>{kicker}</span>
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', whiteSpace: 'nowrap', flex: 'none' }}>{hm(message.ts)}</span>
      </div>
      <p className="hd" style={{ margin: 0, fontSize: 'var(--fs-card)', lineHeight: 1.2 }}>{title}</p>
      {body ? <p style={{ margin: 0, color: 'var(--ink2)', fontSize: 'var(--fs-ui)', whiteSpace: 'pre-wrap' }}>{body}</p> : null}
      {message.meta && message.meta.length > 0 ? (
        <div style={{ border: '1px solid var(--line)', padding: '6px 10px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
          {message.meta.map((row) => <Fragment key={row.k}><span style={{ color: 'var(--ink3)' }}>{row.k}</span><span>{row.v}</span></Fragment>)}
        </div>
      ) : null}
      {resolved ? (
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{resolved === 'declined' ? 'Not now.' : resolved === 'answered' ? 'Answered.' : 'Confirmed.'}</span>
      ) : message.btns && message.btns.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          {message.btns.slice(0, 4).map((button, index) => (
            <button
              key={button.label} type="button" className={buttonClass(button)} data-testid="question-option" data-recommended={index === 0 ? 'true' : 'false'}
              style={{ fontSize: 'var(--fs-key)', letterSpacing: '.03em', lineHeight: 1.3, textAlign: 'left', padding: '10px 14px', minHeight: 44, width: '100%', whiteSpace: 'normal' }}
              onClick={() => { if (lane && onTopic) onTopic(lane); onCommand(button.cmd); }}
            >
              {button.label}
            </button>
          ))}
          <label htmlFor={composerId} data-testid="question-freetext" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', cursor: 'pointer' }}>Or reply below; a typed answer goes to this card.</label>
        </div>
      ) : null}
    </div>
  );
}

export function MessageCard({ message, labelFor, onCommand, onUndo, onTopic, composerId }: {
  message: Message; labelFor?: (id: string) => string | null; onCommand: (text: string) => void;
  onUndo: (jid: string) => void; onTopic?: (laneId: string) => void; composerId: string;
}): JSX.Element | null {
  const label = (id: string): string | null => labelFor?.(id) ?? null;
  const from = message.lane ?? message.source;
  switch (message.type) {
    case 'operator': {
      const to = message.lane ? label(message.lane) ?? 'the agent' : null;
      return (
        <Row ts={message.ts}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
            {to ? <span className="kick" style={{ letterSpacing: '.08em' }}>to the agent on {to}</span> : null}
            <p style={{ margin: 0, padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{message.text}</p>
          </div>
        </Row>
      );
    }
    case 'reply':
      if (!CONDUCTOR_SOURCES.has(message.source)) {
        return (
          <Row ts={message.ts}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="kick" style={{ letterSpacing: '.08em' }}><span className="hd" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink2)', letterSpacing: 0, textTransform: 'none' }}>{label(message.source) ?? 'An agent'}</span> · the agent</span>
              <p style={{ margin: 0, color: 'var(--ink)', paddingLeft: 10, borderLeft: '2px dashed var(--line2)', whiteSpace: 'pre-wrap' }}>{message.text}</p>
              {message.btns && message.btns.length > 0 && !message.resolved ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  {message.btns.map((button) => <button key={button.label} type="button" className={buttonClass(button)} style={{ textAlign: 'left', whiteSpace: 'normal' }} onClick={() => onCommand(button.cmd)}>{button.label}</button>)}
                </div>
              ) : null}
            </div>
          </Row>
        );
      }
      return (
        <Row ts={message.ts}>
          <div>
            <p data-testid="status-row" style={{ margin: 0, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{message.text}</p>
            {message.btns && message.btns.length > 0 && !message.resolved ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {message.btns.map((button) => <button key={button.label} type="button" className={buttonClass(button)} style={{ textAlign: 'left', whiteSpace: 'normal' }} onClick={() => onCommand(button.cmd)}>{button.label}</button>)}
              </div>
            ) : null}
          </div>
        </Row>
      );
    case 'event':
    case 'thinking':
    case 'pr':
      return <Row ts={message.ts}><p data-testid="status-row" style={{ margin: 0, color: 'var(--ink)' }}>{message.type === 'pr' && message.pr ? `Draft PR #${message.pr.no}: ${message.text}` : message.text}</p></Row>;
    case 'activity':
      if (message.tools && message.tools.length > 0) {
        return (
          <details style={{ marginLeft: 48, fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
            <summary className="disc" style={{ gap: 6, alignItems: 'center', fontFamily: 'inherit', fontWeight: 400, letterSpacing: 0, textTransform: 'none', fontSize: 'var(--fs-meta)' }}><span className="tri" />{message.text}</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 14, color: 'var(--ink2)', lineHeight: 1.6 }}>{message.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
          </details>
        );
      }
      return <div style={{ marginLeft: 48, fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{message.text}</div>;
    case 'receipt':
      return (
        <Row ts={message.ts}>
          <p style={{ margin: 0, color: 'var(--ink)', paddingLeft: 10, borderLeft: '2px solid var(--acc)', textDecoration: message.undone ? 'line-through' : 'none' }}>
            {message.text}
            {message.undoable && !message.undone && message.jid ? <> <a href="#" data-testid="receipt-undo" style={{ color: 'var(--acc)', fontSize: 'var(--fs-meta)' }} onClick={(e) => { e.preventDefault(); onUndo(message.jid as string); }}>Undo</a></> : null}
          </p>
        </Row>
      );
    case 'question':
      return (
        <QuestionCard
          variant="rail" freetext="composer" composerId={composerId}
          head={`Question${label(from) ? ` · ${label(from)}` : ''}`}
          stamp={hm(message.ts)} text={message.text} options={message.opts ?? []}
          answer={message.answer}
          onHead={onTopic && !CONDUCTOR_SOURCES.has(from) ? () => onTopic(from) : undefined}
          onAnswer={(answer) => { if (onTopic && !CONDUCTOR_SOURCES.has(from)) onTopic(from); onCommand(`answer ${message.askKey ?? ''} ${answer}`.trim()); }}
        />
      );
    case 'confirm': {
      const laneLabel = label(from);
      const headline = message.title ?? (message.text === 'confirm?' ? (message.blast ?? 'Confirm?') : message.text);
      const body = message.body ?? (message.text === 'confirm?' ? '' : (message.blast ?? ''));
      const withButtons = message.btns && message.btns.length > 0 ? message : { ...message, btns: [{ label: 'Confirm', cmd: `confirm ${message.k}`, cls: 'destroy' as const }, { label: 'Not now', cmd: `dismiss ${message.k}` }] };
      return <ActionCard message={withButtons} tone="acc" kicker={message.kicker ?? `Confirm · cannot be undone${laneLabel ? ` · ${laneLabel}` : ''}`} title={headline} body={body} onCommand={onCommand} onTopic={onTopic} composerId={composerId} />;
    }
    case 'plan':
      return <ActionCard message={message} tone="acc" kicker={message.kicker ?? `Plan · ${message.items?.length ?? 0} actions`} title={message.title ?? message.text} body={message.body ?? (message.items ?? []).map((item, index) => `${index + 1}. ${item.text}${item.irreversible ? ' (cannot be undone)' : ''}`).join('\n')} onCommand={onCommand} onTopic={onTopic} composerId={composerId} />;
    case 'blocker':
      return <ActionCard message={message} tone="warn" kicker={message.kicker ?? `Blocked${label(from) ? ` · ${label(from)}` : ''}`} title={message.title ?? message.text} body={message.body ?? ''} onCommand={onCommand} onTopic={onTopic} composerId={composerId} />;
    case 'decision':
      return <ActionCard message={message} tone="neutral" kicker={message.kicker ?? `Decided for you${label(from) ? ` · ${label(from)}` : ''} · no reply needed`} title={message.title ?? message.text} body={message.body ?? ''} onCommand={onCommand} onTopic={onTopic} composerId={composerId} />;
    case 'refusal':
      return <ActionCard message={message} tone="warn" kicker="Refused" title={message.text} body="" onCommand={onCommand} composerId={composerId} />;
    default:
      return null;
  }
}

export function ConductorRail(props: ConductorRailProps): JSX.Element {
  const { thread, feed, now, composer, onComposerChange, onSend, onCommand, onUndo, labelFor, agentCount, topic = null, recipient = 'conductor', onRecipient, onTopic, commands = DEFAULT_COMMANDS, onStop } = props;
  const composerAction = useStore().state.actions['sendCommand:rail'];
  const busy = composerAction?.pending ?? false;
  // The list opens at the top (the design's 1a). Once the conversation moves (2a to
  // 2d, `stickToEnd`) it follows the newest message, but only while the reader is
  // already at the bottom; a reader who scrolled up keeps their place and gets a
  // count of what arrived below.
  const listRef = useRef<HTMLDivElement | null>(null);
  const seen = useRef<number | null>(null);
  const pinned = useRef(true);
  const [unread, setUnread] = useState(0);
  const atBottom = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  useLayoutEffect(() => {
    const el = listRef.current;
    const grew = seen.current !== null && seen.current > 0 && thread.length > seen.current;
    if (grew && el) {
      if (pinned.current) el.scrollTop = el.scrollHeight;
      else setUnread((n) => n + (thread.length - (seen.current ?? 0)));
    }
    if (thread.length > 0 || seen.current === null) seen.current = thread.length;
  }, [thread.length]);
  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    pinned.current = atBottom(el);
    if (pinned.current) setUnread(0);
  };
  const jump = (): void => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnread(0);
  };
  const toAgent = recipient === 'agent' && topic !== null;
  const composerId = 'rail-composer';
  const send = (): void => {
    const text = composer.trim();
    if (!text || busy) return;
    onSend(text, toAgent ? topic!.id : undefined);
    onComposerChange('');
  };
  const placeholder = !topic ? 'Tell the conductor…'
    : toAgent ? `Talk to the agent working ${topic.label}: tell it what to do instead, ask what it tried, or give it what it needs.`
      : `Answer or ask about ${topic.label}. Long answers are fine; Shift+Enter for a new line.`;
  void now;
  return (
    <aside className="rail" data-testid="conductor-rail" style={{ width: 400, flex: 'none', height: '100%', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)', fontSize: 'var(--fs-body)', lineHeight: 1.45 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="hd" style={{ fontSize: 'var(--fs-card)', letterSpacing: '.02em' }}>Conductor</span>
          {agentCount !== undefined ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{agentCount} {agentCount === 1 ? 'agent' : 'agents'} · {feed.live ? 'live' : 'feed lost'}</span> : null}
        </div>
        <button type="button" className="btn" data-testid="rail-stop" style={{ fontSize: 'var(--fs-ui)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '5px 12px', color: 'var(--warn)', borderColor: 'var(--warn)' }} onClick={() => (onStop ? onStop() : onSend('pause everything'))}>Stop</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div ref={listRef} onScroll={onScroll} data-testid="rail-thread" className="scroll" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {thread.map((message) => (
            <div key={message.k} id={`rail-msg-${message.k}`}>
              <MessageCard message={message} labelFor={labelFor} onCommand={onCommand} onUndo={onUndo} onTopic={onTopic} composerId={composerId} />
            </div>
          ))}
        </div>
        {unread > 0 ? (
          <button type="button" className="btn primary" data-testid="rail-jump" style={{ position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', fontSize: 'var(--fs-meta)', padding: '4px 10px' }} onClick={jump}>{unread} new below</button>
        ) : null}
      </div>
      <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {commands.map((command) => (
            <button key={command.label} type="button" className="btn ghost" style={{ fontFamily: 'Barlow,sans-serif', fontWeight: 400, fontSize: 'var(--fs-meta)', letterSpacing: 0, padding: '4px 9px', color: 'var(--ink2)', borderColor: 'var(--line2)' }} onClick={() => onCommand(command.cmd)}>{command.label}</button>
          ))}
        </div>
        {topic ? (
          <div data-testid="rail-topic" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>About <span className="hd" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink2)', letterSpacing: '.05em' }}>{topic.label}</span> · send to</span>
              <a href="#" style={{ color: 'var(--acc)' }} onClick={(e) => { e.preventDefault(); onTopic?.(null); }}>Clear</a>
            </div>
            <div style={{ display: 'flex', border: '1px solid var(--line2)' }}>
              <button type="button" style={{ flex: 1, font: 'inherit', fontSize: 'var(--fs-meta)', padding: '5px 10px', minHeight: 30, border: 0, cursor: 'pointer', whiteSpace: 'nowrap', background: toAgent ? 'transparent' : 'var(--acc)', color: toAgent ? 'var(--ink2)' : 'var(--accInk)' }} onClick={() => onRecipient?.('conductor')}>Conductor</button>
              <button type="button" style={{ flex: 1, font: 'inherit', fontSize: 'var(--fs-meta)', padding: '5px 10px', minHeight: 30, border: 0, borderLeft: '1px solid var(--line2)', cursor: 'pointer', whiteSpace: 'nowrap', background: toAgent ? 'var(--acc)' : 'transparent', color: toAgent ? 'var(--accInk)' : 'var(--ink2)' }} onClick={() => onRecipient?.('agent')}>The agent on {topic.label}</button>
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <textarea
            id={composerId} className="inp" rows={3} style={{ minHeight: 72 }} placeholder={placeholder} value={composer}
            disabled={!feed.live}
            onChange={(e) => onComposerChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button type="button" className="btn primary" data-testid="action-sendCommand-rail" aria-busy={busy} style={{ alignSelf: 'stretch', fontSize: 'var(--fs-key)', padding: '6px 18px', minWidth: 72 }} onClick={send}>{busy ? 'Working…' : 'Send'}</button>
        </div>
        {!feed.live ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>The feed is disconnected{feed.reason ? ` (${feed.reason})` : ''}; commands resume when it returns.</span> : null}
        {composerAction?.result?.kind === 'done' && !composerAction.result.ok ? <span data-testid="rail-composer-result" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{composerAction.result.text}</span> : null}
      </div>
    </aside>
  );
}
