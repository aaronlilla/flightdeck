import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { hm } from '../freshness.js';
import type { BoardCommand } from '../laneVM.js';
import { boardStateWord, durationWords, laneHeadline } from '../laneVM.js';
import { laneActionLiveness } from '../actionLiveness.js';
import { ACTIONS, useAction } from '../actions.js';
import { busyLabelFor, confirmLabelFor, useCommandConfirming, useCommandPending } from '../commandPending.js';
import type { Lane, LaneStory, LaneSummary } from '../../shared/console-model.js';
import { Marks } from './QuestionCard.js';
import { NarratedLine } from './Narrated.js';

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
  /** `?verbose=1`: every narrated sentence also shows its own fact record. */
  verbose?: boolean;
}

/**
 * Everything a person can do to this lane, in one place.
 *
 * A tile carries one button, chosen by the lane's state, so anything the state did not
 * call for could not be clicked at all: a running lane offered no Pause, a finished one
 * no Retire, and nothing anywhere offered a re-audit. Taking a ticket from the queue to a
 * merge meant leaving the console for a terminal.
 *
 * Every button is gated by the same verdict the board uses, so one that cannot do
 * anything shows why instead of failing on the click.
 */
const LANE_ACTIONS: ReadonlyArray<{ cmd: BoardCommand; label: string }> = [
  { cmd: 'merge', label: 'Merge' },
  { cmd: 'verify', label: 'Verify' },
  { cmd: 'recheck', label: 'Re-check' },
  { cmd: 'reaudit', label: 'Re-audit' },
  { cmd: 'pause', label: 'Pause' },
  { cmd: 'resume', label: 'Resume' },
  { cmd: 'compact', label: 'Compact' },
  { cmd: 'kill', label: 'Stop' },
  { cmd: 'reopen', label: 'Reopen' },
  { cmd: 'retire', label: 'Retire' },
  { cmd: 'unretire', label: 'Unretire' },
];

/** One button in the bar, which says so the moment it is pressed rather than waiting for
 *  the next poll to change the sheet underneath it (Aaron, 2026-09-13). */
function LaneDo({ lane, cmd, label, onCommand }: {
  lane: Lane; cmd: BoardCommand; label: string;
  onCommand: (id: string, cmd: string) => void;
}): JSX.Element {
  const busy = useCommandPending(lane.id, cmd);
  const confirmToken = useCommandConfirming(lane.id, cmd);
  return (
    <button
      type="button" className={`btn ${confirmToken ? 'warn' : ''}`} data-testid={`lane-do-${cmd}`}
      aria-busy={busy} disabled={busy}
      onClick={() => onCommand(lane.id, confirmToken ? `confirm:${confirmToken}` : cmd)}
    >
      {busy ? busyLabelFor(cmd, label) : confirmToken ? confirmLabelFor(cmd, label) : label}
    </button>
  );
}

function LaneActions({ lane, onCommand }: {
  lane: Lane; onCommand: (id: string, cmd: string) => void;
}): JSX.Element {
  const verdicts = LANE_ACTIONS.map((action) => ({
    ...action, verdict: laneActionLiveness({ lane, cmd: action.cmd }),
  }));
  const live = verdicts.filter((row) => row.verdict.live);
  const dead = verdicts.filter((row) => !row.verdict.live);
  return (
    <div data-testid="lane-actions" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="kick">Do</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {live.map((row) => (
          <LaneDo key={row.cmd} lane={lane} cmd={row.cmd} label={row.label} onCommand={onCommand} />
        ))}
        {live.length === 0 ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Nothing to do here</span> : null}
      </div>
      {dead.length > 0 ? (
        <details data-testid="lane-actions-unavailable">
          <summary className="kick" style={{ cursor: 'pointer', color: 'var(--ink3)' }}>{`${dead.length} not available`}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>
            {dead.map((row) => (
              <span key={row.cmd} style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
                {`${row.label} — ${row.verdict.live === false ? row.verdict.why : ''}`}
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The two things a lane takes that are not a single click: a change to what it was asked
 * to do, and a ceiling on what it may spend doing it.
 *
 * Both had a server route and a registry entry and no control anywhere, so steering a run
 * without stopping it meant a terminal. Folded away rather than laid out, because most
 * visits to a sheet are to read it.
 */
function LaneSteering({ lane }: { lane: Lane }): JSX.Element {
  const amend = useAction(ACTIONS.amendRun, lane.id);
  const cap = useAction(ACTIONS.setRunCap, lane.id);
  const [text, setText] = useState('');
  const [tokens, setTokens] = useState('');
  const capNumber = Number.parseInt(tokens, 10);
  const capValid = Number.isInteger(capNumber) && capNumber > 0;
  return (
    <details data-testid="lane-steering">
      <summary className="kick" style={{ cursor: 'pointer', color: 'var(--ink3)' }}>Change what it is doing</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="kick" htmlFor={`amend-${lane.id}`}>Add to the brief</label>
          <textarea
            id={`amend-${lane.id}`} data-testid="lane-amend-input" rows={2}
            placeholder="What it should also do"
            value={text} onChange={(event) => { setText(event.target.value); }}
            style={{ font: 'inherit', fontSize: 'var(--fs-body)', padding: '8px 10px', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', resize: 'vertical' }}
          />
          <button
            type="button" className="btn" data-testid="lane-amend-submit"
            disabled={text.trim().length === 0 || amend.pending}
            onClick={() => { void amend.run(lane.id, text.trim()).then(() => setText('')); }}
            style={{ alignSelf: 'flex-start' }}
          >
            {amend.pending ? 'Sending…' : 'Add to the brief'}
          </button>
          {amend.result?.kind === 'done' && !amend.result.ok ? (
            <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{amend.result.text}</span>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="kick" htmlFor={`cap-${lane.id}`}>Stop it after this many tokens</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              id={`cap-${lane.id}`} data-testid="lane-cap-input" type="number" min={1} inputMode="numeric"
              placeholder="no ceiling"
              value={tokens} onChange={(event) => { setTokens(event.target.value); }}
              style={{ width: 140, font: 'inherit', fontSize: 'var(--fs-body)', padding: '7px 10px', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
            />
            <button
              type="button" className="btn" data-testid="lane-cap-submit"
              disabled={!capValid || cap.pending}
              onClick={() => { void cap.run(lane.id, capNumber); }}
            >
              {cap.pending ? 'Saving…' : 'Set the ceiling'}
            </button>
          </div>
          {cap.result?.kind === 'done' && !cap.result.ok ? (
            <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{cap.result.text}</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}

export function TicketSheet({ lane, now, onClose, onCommand, onSendLane, verbose }: TicketSheetProps): JSX.Element {
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
    // The page's command path rejects on a refusal since R-75; a bare `.then` here would
    // raise an unhandled rejection the moment the fleet turned a note down.
    void Promise.resolve(onSendLane(lane.id, text)).then(() => setSent(text)).catch(() => undefined);
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
      <div className="scroll sheet-body" style={{ flex: 1, overflow: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--fs-key)' }}>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 54 }}>Did</span>{failed ? `The summary did not load: ${failed}` : summary ? <NarratedLine bag={summary.narration ?? lane.narration} field={summary.narration?.['what'] ? 'what' : 'did'} glance={summary.what.join(' ') || lane.did || 'Nothing yet'} verbose={verbose} testid="sheet-what" /> : 'Loading…'}</p>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 54 }}>Now</span><NarratedLine bag={summary?.narration ?? lane.narration} field={summary?.narration?.['status'] ? 'status' : 'now'} glance={summary?.status ?? lane.now ?? ''} verbose={verbose} testid="sheet-status" /></p>
          <p style={{ margin: 0 }}><span className="kick" style={{ display: 'inline-block', width: 54 }}>Next</span><NarratedLine bag={summary?.narration ?? lane.narration} field={summary?.narration?.['next'] ? 'next' : 'you'} glance={summary?.next ?? lane.you ?? ''} verbose={verbose} testid="sheet-next" /></p>
        </div>
        <LaneActions lane={lane} onCommand={onCommand} />
        <LaneSteering lane={lane} />
        {question ? (
          <div style={{ position: 'relative', border: '1px solid var(--warn)', background: 'var(--warnTint)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Marks />
            <span className="kick" style={{ color: 'var(--warn)', fontWeight: 700 }}>It asked · {hm(question.askedAt)}</span>
            <p className="hd" dir="auto" style={{ margin: 0, fontSize: 'var(--fs-heading)', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{question.text.trim() || 'No question text'}</p>
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <span className="kick" style={{ marginBottom: 8 }}>Story</span>
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
          <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '2px 12px', fontSize: 'var(--fs-meta)', color: 'var(--ink2)', overflowWrap: 'anywhere' }}>
            <dt style={{ color: 'var(--ink3)' }}>Run</dt><dd style={{ margin: 0 }}>{lane.id}</dd>
            {lane.sandbox?.branch ? <><dt style={{ color: 'var(--ink3)' }}>Branch</dt><dd style={{ margin: 0 }}>{lane.sandbox.branch}</dd></> : null}
            {lane.sandbox?.path ? <><dt style={{ color: 'var(--ink3)' }}>Worktree</dt><dd style={{ margin: 0 }}>{lane.sandbox.path}</dd></> : null}
            {lane.live.pid ? <><dt style={{ color: 'var(--ink3)' }}>Process</dt><dd style={{ margin: 0 }}>{lane.live.pid}{lane.live.alive ? ' (alive)' : ' (gone)'}</dd></> : null}
            <dt style={{ color: 'var(--ink3)' }}>Model</dt><dd style={{ margin: 0 }}>{lane.modelId ?? lane.model}</dd>
            {lane.pr ? <><dt style={{ color: 'var(--ink3)' }}>PR</dt><dd style={{ margin: 0 }}><a href={lane.pr.url} target="_blank" rel="noopener">#{lane.pr.no}</a></dd></> : null}
          </dl>
        </details>
      </div>
      <div className="scroll" style={{ borderTop: '1px solid var(--line)', padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '55%', overflow: 'auto', flex: 'none' }}>
        {question ? (
          <div data-testid="question-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="kick" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)', fontWeight: 700 }}>Answer</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {question.opts.filter((option) => option.trim().length > 0).map((option, index) => (
                <button key={option} type="button" className="opt" data-testid="question-option" data-recommended={index === 0 ? 'true' : 'false'} onClick={() => submitAnswer(option)}><i /><span>{option}</span></button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <textarea className="inp warnFocus" data-testid="question-freetext" rows={2} style={{ minHeight: 56 }} placeholder="Or type an answer" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(answer); } }} />
              <button type="button" className="btn warn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px', minWidth: 88 }} onClick={() => submitAnswer(answer)}>Answer</button>
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="kick" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>Note</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <input className="inp" data-testid="sheet-note" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
            <button type="button" className="btn" style={{ fontSize: 'var(--fs-key)', padding: '6px 18px', minWidth: 88 }} onClick={submitNote}>Send</button>
          </div>
          {sent ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Sent: {sent}</span> : null}
        </div>
      </div>
    </aside>
  );
}
