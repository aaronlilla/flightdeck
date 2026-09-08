import type { JSX } from 'react';
import { useState } from 'react';

import type {
  Caps, Feed, Integration, JournalEntry, Lane, Rule,
} from '../../shared/console-model.js';
import { hm } from '../freshness.js';
import { fmtTokens } from '../../shared/format-tokens.js';

/** A cap this file reads as `Infinity` (no console override yet, and nothing this board
 *  can honestly derive from the policy's own dollar-denominated defaults) prints as
 *  "uncapped" rather than the literal word "Infinity". */
function capText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'uncapped';
  return `${fmtTokens(value)} tokens`;
}

export interface SettingsProps {
  integrations: Integration[];
  caps: Caps | null;
  journalCount: number;
  journal: JournalEntry[];
  rules: Rule[];
  lanes: Lane[];
  feed: Feed;
  now: number;
  onCheck: (id: string) => void;
  onReconnect: (id: string) => void;
  onCheckAll: () => void;
  onSaveCaps: (dailyTokens: number, runTokens: number) => Promise<void> | void;
  onOpenJournal: () => void;
}

type Section = 'integrations' | 'caps' | 'models' | 'repos' | 'notifications' | 'shortcuts';

const NAV_ITEMS: { id: Section; label: string }[] = [
  { id: 'integrations', label: 'Integrations' },
  { id: 'caps', label: 'Caps & policies' },
  { id: 'models', label: 'Models & routing' },
  { id: 'repos', label: 'Repos & queues' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

const STATUS_COLOR: Record<Integration['status'], string> = {
  ok: 'var(--run)', down: 'var(--block)', degraded: 'var(--park)', off: 'var(--ink3)', busy: 'var(--hand)', checking: 'var(--ink3)',
};

function ctaFor(i: Integration): string {
  if (i.status === 'down') return i.kind === 'mcp' ? 'Fix →' : (i.fixLabel ?? 'Reconnect →');
  if (i.status === 'degraded') return 'Restart';
  if (i.status === 'off') return 'Connect';
  return 'manage';
}

/** An MCP server runs over stdio, so a healthy row with no measured latency says so
 *  instead of the generic "--" a connection with nothing to report would print. */
function latencyDisplay(i: Integration): string {
  if (i.latencyMs !== null) return `${i.latencyMs} ms`;
  if (i.kind === 'mcp' && i.status === 'ok') return 'stdio';
  return '--';
}

/** A row's own freshness stamp: `observed hh:mm` while it's down (the last good read is
 *  all there is), `✓ Ns ago` once there's a `checkedAt` to age against, `--` before the
 *  first check ever lands. Mirrors the prototype's `intVM`, which keys this off status
 *  and `checkedAt` alone rather than the lane-side verified/observed window. */
function rowFreshness(i: Integration, now: number): { cls: 'stF' | 'stO'; text: string } {
  if (i.status === 'down') return { cls: 'stO', text: `observed ${hm(i.checkedAt)}` };
  if (!i.checkedAt) return { cls: 'stO', text: '--' };
  const seconds = Math.max(0, Math.round((now - i.checkedAt) / 1000));
  return { cls: 'stF', text: `✓ ${seconds}s ago` };
}

/** A down or degraded row gets a faint tint of its own status color, matching the
 *  prototype's `intVM` (`bg: bad ? color-mix(in srgb, col 8%, transparent) :
 *  transparent`); a healthy, off, or checking row stays plain. */
function rowBackground(status: Integration['status']): string {
  if (status !== 'down' && status !== 'degraded') return 'transparent';
  return `color-mix(in srgb, ${STATUS_COLOR[status]} 8%, transparent)`;
}

function Row({ i, now, onCheck, onReconnect }: {
  i: Integration; now: number; onCheck: (id: string) => void; onReconnect: (id: string) => void;
}): JSX.Element {
  const fresh = rowFreshness(i, now);
  return (
    <div className="row" style={{ background: rowBackground(i.status) }}>
      <span className="led" style={{ background: STATUS_COLOR[i.status] }} />
      <b>{i.name}</b>
      <span style={{ color: 'var(--ink2)' }}>{i.desc}</span>
      <span style={{ color: 'var(--ink2)' }}>{latencyDisplay(i)}</span>
      <span className={fresh.cls}>{fresh.text}</span>
      <span
        className="btnS" style={{ padding: '5px 10px', fontSize: '9.5px', justifySelf: 'end', textAlign: 'right' }}
        onClick={() => (i.status === 'down' ? onReconnect(i.id) : onCheck(i.id))}
      >
        {ctaFor(i)}
      </span>
    </div>
  );
}

/** The down-plate's footer: when it last read healthy, and how many checks have failed
 *  since. Built from `Integration.lastHealthyAt` / `retryCount`, not a fixed sentence. */
function downFooter(i: Integration): string {
  const last = i.lastHealthyAt ? hm(i.lastHealthyAt) : 'never observed';
  const retries = i.retryCount;
  return `last healthy ${last} · ${retries} auto-${retries === 1 ? 'retry' : 'retries'} failed`;
}

interface ModelClassGroup {
  className: string;
  models: string[];
  laneCount: number;
}

/** Which model each policy class is actually routing to, read off the lanes running
 *  right now rather than a static copy of `model-policy.json` -- the console bundle
 *  never imports `src/forge/**`, so this is the only live signal it has. */
function modelClassGroups(lanes: Lane[]): ModelClassGroup[] {
  const byClass = new Map<string, { models: Set<string>; count: number }>();
  for (const lane of lanes) {
    const key = lane.className ?? 'unclassified';
    const entry = byClass.get(key) ?? { models: new Set<string>(), count: 0 };
    entry.models.add(lane.model);
    entry.count += 1;
    byClass.set(key, entry);
  }
  return [...byClass.entries()]
    .map(([className, v]) => ({ className, models: [...v.models].sort(), laneCount: v.count }))
    .sort((a, b) => b.laneCount - a.laneCount);
}

interface RepoQueueGroup {
  repo: string;
  total: number;
  running: number;
  blocked: number;
  parked: number;
}

function repoQueueGroups(lanes: Lane[]): RepoQueueGroup[] {
  const byRepo = new Map<string, RepoQueueGroup>();
  for (const lane of lanes) {
    const key = lane.repo ?? 'unspecified';
    const entry = byRepo.get(key) ?? { repo: key, total: 0, running: 0, blocked: 0, parked: 0 };
    entry.total += 1;
    if (lane.state === 'running' || lane.state === 'handed-off') entry.running += 1;
    if (lane.state === 'blocked') entry.blocked += 1;
    if (lane.state === 'parked') entry.parked += 1;
    byRepo.set(key, entry);
  }
  return [...byRepo.values()].sort((a, b) => b.total - a.total);
}

/** Whether the cap backstop has actually fired, read off the `kill3` rule's own status
 *  rather than a seeded string: `applied` means it backstopped a run today, anything
 *  else means it hasn't. No rule named `kill3` (a fleet that never proposed one) falls
 *  back to the plain on/off the caps config itself carries. */
function capEnforcement(caps: Caps | null, rules: Rule[]): { text: string; color: string } {
  const kill3 = rules.find((r) => r.id === 'kill3');
  if (kill3) {
    return kill3.status === 'applied'
      ? { text: 'ok · rule kill3 backstop', color: 'var(--run)' }
      : { text: 'not enforced yet', color: 'var(--block)' };
  }
  const on = caps?.enforcement === 'on';
  return { text: caps?.enforcement ?? 'off', color: on ? 'var(--run)' : 'var(--ink3)' };
}

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: '⌘K / Ctrl+K', action: 'open the command palette' },
  { keys: 'Esc', action: 'close the open sheet or palette' },
];

/** Settings: a 210px section rail plus, per section, Integrations' down plate/connections/
 *  MCP tables, a caps overrides view, models & routing, repos & queues, notifications, or
 *  shortcuts. The right rail (caps form, connection-loss policy, recent journal) stays
 *  fixed across every section, matching the prototype's own layout. */
export function Settings(props: SettingsProps): JSX.Element {
  const {
    integrations, caps, journalCount, journal, rules, lanes, feed, now,
    onCheck, onReconnect, onCheckAll, onSaveCaps, onOpenJournal,
  } = props;
  const [section, setSection] = useState<Section>('integrations');
  const [dailyDraft, setDailyDraft] = useState(caps && Number.isFinite(caps.dailyTokens) ? String(caps.dailyTokens) : '');
  const [runDraft, setRunDraft] = useState(caps && Number.isFinite(caps.runTokens) ? String(caps.runTokens) : '');
  const [err, setErr] = useState('');

  const down = integrations.filter((i) => i.status === 'down');
  const conns = integrations.filter((i) => i.kind === 'conn');
  const mcps = integrations.filter((i) => i.kind === 'mcp');
  const enforcement = capEnforcement(caps, rules);
  const recentJournal = journal.slice(-5).reverse();

  async function save(): Promise<void> {
    const daily = Number(dailyDraft);
    const run = Number(runDraft);
    if (!Number.isFinite(daily) || !Number.isFinite(run)) { setErr('caps must be numbers'); return; }
    if (caps && (daily > caps.hardTokens || run > caps.hardTokens)) { setErr(`refused above the org hard limit of ${capText(caps.hardTokens)}`); return; }
    setErr('');
    await onSaveCaps(daily, run);
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }} data-testid="settings-view">
      <div style={{ width: 210, borderRight: '1px solid var(--line)', padding: '18px 0', background: 'var(--panel)' }}>
        <div className="m" style={{ fontSize: '11.5px', lineHeight: 2.6, padding: '0 22px' }}>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              data-testid={`settings-nav-${item.id}`}
              onClick={() => setSection(item.id)}
              style={{
                cursor: 'pointer',
                fontWeight: section === item.id ? 700 : 400,
                color: section === item.id ? undefined : (item.id === 'caps' ? 'var(--ink2)' : 'var(--ink3)'),
                borderLeft: section === item.id ? '2px solid var(--run)' : '2px solid transparent',
                marginLeft: -22, paddingLeft: 20,
              }}
            >
              {item.label}
            </div>
          ))}
          <div style={{ color: 'var(--ink2)', cursor: 'pointer' }} onClick={onOpenJournal}>
            Audit journal <span className="chip" style={{ fontSize: 8 }}>{journalCount}</span>
          </div>
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {section === 'integrations' ? (
          <>
            {down.map((d) => (
              <div key={d.id} className="plate" style={{ border: '2px solid var(--block)', padding: 0 }}>
                <div className="lbl" style={{ background: 'var(--block)', color: 'var(--aInk)', padding: '7px 16px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>■ disconnected</span>
                  <span>{d.dependents.length} lanes blocked · since {d.since ? hm(d.since) : '--'}</span>
                </div>
                <div style={{ display: 'flex', gap: 22, padding: 16, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="m" style={{ fontSize: 16, fontWeight: 700 }}>{d.name}</span>
                      {d.scope ? <span className="chip">{d.scope}</span> : null}
                    </div>
                    <div className="m" style={{ fontSize: '11.5px', lineHeight: 1.9, color: 'var(--ink2)', marginTop: 8 }}>
                      <b style={{ color: 'var(--ink)' }}>cause</b> {d.cause}<br />
                      <b style={{ color: 'var(--ink)' }}>effect</b> {d.effect}<br />
                      <b style={{ color: 'var(--ink)' }}>fix</b> {d.fix}
                    </div>
                    <div className="m" style={{ fontSize: '10.5px', color: 'var(--ink3)', marginTop: 8 }}>{downFooter(d)}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', width: 230 }}>
                    <span className="btnR" style={{ padding: 12, fontSize: 12 }} onClick={() => onReconnect(d.id)}>{d.fixLabel ?? 'Reconnect via SSO'} →</span>
                    <span className="m" style={{ fontSize: '9.5px', color: 'var(--ink3)', textAlign: 'center' }}>≈ 20s · no restart</span>
                  </div>
                </div>
              </div>
            ))}
            <div className="plate" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <span className="lbl">Connections</span>
                <span className="m" style={{ fontSize: 10, color: 'var(--ink2)' }}>checked every 30s · <a onClick={onCheckAll}>check now</a></span>
              </div>
              <div className="m" style={{ fontSize: '11.5px' }}>
                {conns.map((i) => <Row key={i.id} i={i} now={now} onCheck={onCheck} onReconnect={onReconnect} />)}
              </div>
            </div>
            <div className="plate" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <span className="lbl">MCP servers</span>
              </div>
              <div className="m" style={{ fontSize: '11.5px' }}>
                {mcps.map((i) => <Row key={i.id} i={i} now={now} onCheck={onCheck} onReconnect={onReconnect} />)}
              </div>
            </div>
          </>
        ) : null}

        {section === 'caps' ? (
          <div className="plate" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span className="lbl">Per-run overrides</span></div>
            <div className="m" style={{ fontSize: '11.5px', padding: '10px 16px' }}>
              {caps && Object.keys(caps.overrides).length > 0 ? (
                Object.entries(caps.overrides).map(([id, tokenCap]) => (
                  <div key={id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span>{id}</span><b>{fmtTokens(tokenCap)} tokens</b>
                  </div>
                ))
              ) : (
                <span style={{ color: 'var(--ink3)' }}>no per-run overrides set</span>
              )}
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)' }}>
              <span className="lbl">Tokens today</span>
              <div className="m" style={{ fontSize: '11.5px', marginTop: 6 }}>
                {fmtTokens(caps?.tokensToday ?? 0)} of {capText(caps?.dailyTokens)} daily · {capText(caps?.runTokens)} per run · {capText(caps?.hardTokens)} hard limit
              </div>
            </div>
          </div>
        ) : null}

        {section === 'models' ? (
          <div className="plate" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span className="lbl">Models & routing</span></div>
            <div className="m" style={{ fontSize: '11.5px' }}>
              {modelClassGroups(lanes).length > 0 ? modelClassGroups(lanes).map((g) => (
                <div key={g.className} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                  <span>{g.className}</span>
                  <span style={{ color: 'var(--ink2)' }}>{g.models.join(', ')} · {g.laneCount} lane{g.laneCount === 1 ? '' : 's'}</span>
                </div>
              )) : (
                <div style={{ padding: '10px 16px', color: 'var(--ink3)' }}>no lanes have reported a model class yet</div>
              )}
            </div>
          </div>
        ) : null}

        {section === 'repos' ? (
          <div className="plate" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span className="lbl">Repos & queues</span></div>
            <div className="m" style={{ fontSize: '11.5px' }}>
              {repoQueueGroups(lanes).length > 0 ? repoQueueGroups(lanes).map((g) => (
                <div key={g.repo} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                  <span>{g.repo}</span>
                  <span style={{ color: 'var(--ink2)' }}>{g.total} lane{g.total === 1 ? '' : 's'} · {g.running} running · {g.blocked} blocked · {g.parked} parked</span>
                </div>
              )) : (
                <div style={{ padding: '10px 16px', color: 'var(--ink3)' }}>no repos have queued lanes yet</div>
              )}
            </div>
          </div>
        ) : null}

        {section === 'notifications' ? (
          <div className="plate" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span className="lbl">Notifications</span></div>
            <div className="m" style={{ fontSize: 11, lineHeight: 2.4, padding: '10px 16px', color: 'var(--ink2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>live feed</span><b>{feed.live ? 'connected' : `lost${feed.lostAt ? ` ${hm(feed.lostAt)}` : ''}`}</b></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>needs you</span><b>{lanes.filter((l) => l.state === 'parked' || l.state === 'blocked' || l.runaway).length} lane(s)</b></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>flight review</span><b>{rules.filter((r) => r.status === 'open').length} open proposal(s)</b></div>
            </div>
          </div>
        ) : null}

        {section === 'shortcuts' ? (
          <div className="plate" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span className="lbl">Shortcuts</span></div>
            <div className="m" style={{ fontSize: '11.5px' }}>
              {SHORTCUTS.map((s) => (
                <div key={s.keys} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                  <b>{s.keys}</b><span style={{ color: 'var(--ink2)' }}>{s.action}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ width: 300, borderLeft: '1px solid var(--line)', padding: '22px 20px', background: 'var(--panel)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>Caps &amp; policies</div>
          <div className="m" style={{ fontSize: '11.5px', lineHeight: 2.4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ink2)' }}>daily cap (tokens)</span>
              <span><input className="inp m" style={{ width: 90, fontSize: 12, fontWeight: 700, textAlign: 'right' }} value={dailyDraft} onChange={(e) => setDailyDraft(e.target.value)} /></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ink2)' }}>per-run cap (tokens)</span>
              <span><input className="inp m" style={{ width: 90, fontSize: 12, fontWeight: 700, textAlign: 'right' }} value={runDraft} onChange={(e) => setRunDraft(e.target.value)} /></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink2)' }}>org hard limit</span><b>{capText(caps?.hardTokens)} · FD-7</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink2)' }}>cap enforcement</span><span style={{ fontWeight: 700, color: enforcement.color }}>{enforcement.text}</span></div>
          </div>
          <span className="btnP" style={{ width: '100%', marginTop: 6 }} onClick={() => void save()}>Save caps →</span>
          <div className="m" style={{ fontSize: 10, color: 'var(--block)', marginTop: 6, minHeight: 14 }}>{err}</div>
        </div>
        <div>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>On connection loss</div>
          <div className="m" style={{ fontSize: 11, lineHeight: 1.9, color: 'var(--ink2)' }}>
            Needs-you strip within 30s, with fix button<br />
            Dependent lanes hold, do not fail<br />
            2 auto-retries, then operator<br />
            No irreversible action while a dependency is down
          </div>
        </div>
        <div>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>Recent</div>
          <div className="m" style={{ fontSize: '10.5px', lineHeight: 2, color: 'var(--ink2)' }}>
            {recentJournal.length > 0 ? recentJournal.map((j) => (
              <div key={j.jid}>
                <a style={{ color: 'var(--ink)', fontWeight: 600, textDecoration: 'none', cursor: 'pointer' }} onClick={onOpenJournal}>{hm(j.ts)}</a> {j.text}
              </div>
            )) : <span style={{ color: 'var(--ink3)' }}>no journal entries yet</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
