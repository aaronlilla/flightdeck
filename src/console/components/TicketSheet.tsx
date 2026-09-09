import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { hm } from '../freshness.js';
import { boardStateWord, durationWords, laneHeadline } from '../laneVM.js';
import type { Lane, LaneStory, LaneSummary } from '../../shared/console-model.js';
import { Marks } from './QuestionCard.js';

/**
 * `Flightdeck Console.dc.html` 1d: the lane sheet over the board. Its title and state,
 * three sentences (what happened, where it is, what is next) off the run's summary, the
 * question it asked if there is one, its story as a timeline, and two separate controls:
 * Answer for the question, Send for a note while it works. The run's ids sit behind one
 * "Technical" disclosure.
 */
export interface TicketSheetProps {
  lane: Lane;
  now: number;
  onClose: () => void;
  /** `answer <key> <text>` and the run's other commands, through the page. */
  onCommand: (id: string, cmd: string) => void;
  /** A note to the agent while it works (`POST /command` with the run as context). */
  onSendLane: (id: string, text: string) => void | Promise<unknown>;
}

export function TicketSheet({ lane, now, onClose, onCommand, onSendLane }: TicketSheetProps): JSX.Element {
  const [summary, setSummary] = useState<LaneSummary | null>(null);
  const [story, setStory] = useState<LaneStory | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSummary(null); setStory(null); setFailed(null);
    api.getRunSummary(lane.id).then((r) => { if (active) setSummary(r); }).catch((error: unknown) => { if (active) setFailed(error instanceof Error ? error.message : String(error)); });
    api.getRunStory(lane.id).then((r) => { if (active) setStory(r); }).catch(() => undefined);
    return () => { active = false; };
  }, [lane.id]);

  const word = boardStateWord(lane);
  const head = laneHeadline(lane);
  const question = lane.question;
  const submitAnswer = (text: string): void => {
    if (!question || !text.trim()) return;
    onCommand(lane.id, `answer ${question.key} ${text.trim()}`);
    setAnswer('');
  };
  const submitNote = (): void => {
    const text = note.trim();
    if (!text) return;
    void Promise.resolve(onSendLane(lane.id, text)).then(() => setSent(text));
    setNote('');
  };
  const entries = story?.entries ?? [];
  return (
    <aside data-testid="ticket-sheet" role="dialog" aria-label={head.main} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 600, background: 'var(--bg)', borderLeft: '1px solid var(--line2)', boxShadow: '-12px 0 32px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div className="key">{lane.ticket ?? ''}{lane.ticket ? ' · ' : ''}<span style={{ color: word.color }}>{word.word} · {durationWords(now - lane.since)}</span></div>
          <h2 className="hd" data-testid="sheet-title" style={{ margin: '2px 0 0', fontSize: 'var(--fs-sheet)', lineHeight: 1.1 }}>{lane.title ?? head.main}</h2>
        </div>
        <button type="button" aria-label="Close" data-testid="sheet-close" style={{ width: 32, height: 32, flex: 'none', background: 'transparent', border: '1px solid var(--line2)', color: 'var(--ink2)', fontSize: 'var(--fs-key)', cursor: 'pointer', borderRadius: 0 }} onClick={onClose}>✕</button>
      </div>
      <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--fs-key)' }}>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 110 }}>What happened</span>{failed ? `The summary did not load: ${failed}` : summary ? (summary.what.join(' ') || lane.did || 'Nothing on record yet.') : 'Loading…'}</p>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 110 }}>Where it is</span>{summary?.status ?? lane.now ?? ''}</p>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 110 }}>What's next</span>{summary?.next ?? lane.you ?? ''}</p>
        </div>
        {question ? (
          <div style={{ position: 'relative', border: '1px solid var(--warn)', background: 'var(--warnTint)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Marks />
            <span className="kick" style={{ color: 'var(--warn)', fontWeight: 700 }}>It asked · {hm(question.askedAt)}</span>
            <p className="hd" style={{ margin: 0, fontSize: 'var(--fs-heading)', lineHeight: 1.2 }}>{question.text}</p>
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <span className="kick" style={{ marginBottom: 8 }}>Its story</span>
          {entries.map((entry, index) => (
            <div key={`${entry.at}-${index}`} style={{ display: 'grid', gridTemplateColumns: '44px 14px 1fr', gap: 10, alignItems: 'baseline', padding: '5px 0' }}>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums' }}>{hm(entry.at)}</span>
              <span style={{ width: 7, height: 7, background: entry.kind === 'park' || entry.kind === 'answer' ? 'var(--warn)' : 'var(--ink3)', display: 'inline-block', alignSelf: 'center', marginLeft: 3 }} />
              <span style={{ color: entry.kind === 'park' ? 'var(--ink)' : 'var(--ink2)' }}>{entry.url ? <a href={entry.url} target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'underline' }}>{entry.text}</a> : entry.text}</span>
            </div>
          ))}
          {summary?.next ? (
            <div style={{ display: 'grid', gridTemplateColumns: '44px 14px 1fr', gap: 10, alignItems: 'baseline', padding: '5px 0' }}>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>next</span>
              <span style={{ width: 7, height: 7, background: 'transparent', display: 'inline-block', alignSelf: 'center', marginLeft: 3 }} />
              <span style={{ color: 'var(--ink3)' }}>{summary.next}</span>
            </div>
          ) : null}
        </div>
        <details>
          <summary className="disc" style={{ alignItems: 'center' }}><span className="tri" />Technical</summary>
          <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
            <dt style={{ color: 'var(--ink3)' }}>Run</dt><dd style={{ margin: 0 }}>{lane.id}</dd>
            {lane.sandbox?.branch ? <><dt style={{ color: 'var(--ink3)' }}>Branch</dt><dd style={{ margin: 0 }}>{lane.sandbox.branch}</dd></> : null}
            {lane.sandbox?.path ? <><dt style={{ color: 'var(--ink3)' }}>Worktree</dt><dd style={{ margin: 0 }}>{lane.sandbox.path}</dd></> : null}
            {lane.live.pid ? <><dt style={{ color: 'var(--ink3)' }}>Process</dt><dd style={{ margin: 0 }}>{lane.live.pid}{lane.live.alive ? ' (alive)' : ' (gone)'}</dd></> : null}
            <dt style={{ color: 'var(--ink3)' }}>Model</dt><dd style={{ margin: 0 }}>{lane.modelId ?? lane.model}</dd>
            {lane.pr ? <><dt style={{ color: 'var(--ink3)' }}>PR</dt><dd style={{ margin: 0 }}><a href={lane.pr.url} target="_blank" rel="noopener">#{lane.pr.no}</a></dd></> : null}
          </dl>
        </details>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {question ? (
          <div data-testid="question-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="kick" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)', fontWeight: 700 }}>Answer its question</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {question.opts.slice(0, 4).map((option, index) => (
                <button key={option} type="button" className="opt" data-testid="question-option" data-recommended={index === 0 ? 'true' : 'false'} onClick={() => submitAnswer(option)}><i /><span>{option}</span></button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <textarea className="inp warnFocus" data-testid="question-freetext" rows={2} style={{ minHeight: 56 }} placeholder="Or write the answer in full…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(answer); } }} />
              <button type="button" className="btn warn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px', minWidth: 88 }} onClick={() => submitAnswer(answer)}>Answer</button>
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="kick" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>Send a note while it works</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <input className="inp" data-testid="sheet-note" placeholder="e.g. Use the existing redis client" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
            <button type="button" className="btn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px', minWidth: 88 }} onClick={submitNote}>Send</button>
          </div>
          {sent ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Sent: {sent}</span> : null}
        </div>
      </div>
    </aside>
  );
}
