/**
 * Fixture `/state` shape, copied from `server.ts#state()` and
 * `supervisor.ts#LANE_FIELDS` on main (decision 6: cut 1's own fixtures
 * until `src/forge/contracts.ts` merges).
 *
 * `burn` is deliberately given only `observed_at`, with no `verified_at`, to
 * exercise the P6.3 "stale events render with both values" distinction:
 * today's real server always stamps `verified_at` on every field (the known
 * over-claim the contracts work fixes), so a genuinely unverified field does
 * not occur there yet. This fixture is how cut 1 proves the console already
 * renders the difference the day one shows up.
 */
import type { ForgeState, LaneRecord } from '../types.js';

const now = Date.parse('2026-09-04T18:00:00Z');

export const laneRunning: LaneRecord = {
  slug: 'card-network-glow',
  column: 'in-progress',
  owner: 'forge',
  session_id: 'sess-9f21',
  claude_pid: 44821,
  started: now - 42 * 60_000,
  ended: null,
  verdict: null,
  position: 1,
  note: null,
  woken: 0,
  model: 'claude-sonnet-5',
  context: 86_000,
  cost_usd: 4.32,
  handoff: null,
  usd_per_hour: 6.17,
  verified_at: now - 4_000,
  last_event_age_s: 12,
  current_tool: { name: 'Bash', startedAt: now - 12_000 },
  goal: 'card-network-glow-launch',
  className: 'implement',
  provider: 'anthropic',
};

export const laneBlocked: LaneRecord = {
  slug: 'withdrawal-fee',
  column: 'blocked',
  owner: 'forge',
  session_id: 'sess-7a03',
  claude_pid: 44902,
  started: now - 3 * 3_600_000,
  ended: null,
  verdict: null,
  position: 2,
  note: 'parked on a question',
  woken: 1,
  model: 'claude-sonnet-5',
  context: 141_000,
  cost_usd: 11.06,
  handoff: null,
  usd_per_hour: 3.69,
  verified_at: now - 8 * 60_000,
  last_event_age_s: 480,
  current_tool: null,
  goal: 'withdrawal-fee',
  className: 'implement-hard',
  provider: 'anthropic',
};

export const laneDone: LaneRecord = {
  slug: 'tour-and-onboarding',
  column: 'done',
  owner: 'forge',
  session_id: 'sess-1290',
  claude_pid: null,
  started: now - 6 * 3_600_000,
  ended: now - 20 * 60_000,
  verdict: 'passed',
  position: 3,
  note: null,
  woken: 0,
  model: 'claude-sonnet-5',
  context: 0,
  cost_usd: 8.91,
  handoff: null,
  usd_per_hour: 0,
  verified_at: now - 20 * 60_000,
  last_event_age_s: 1200,
  current_tool: null,
  goal: 'tour-and-onboarding',
  className: 'implement',
  provider: 'anthropic',
};

export const fleetStateFixture: ForgeState = {
  at: now,
  lanes: { value: [laneRunning, laneBlocked, laneDone], verified_at: now },
  burn: { value: { sonnet: 24.29, haiku: 1.04 }, observed_at: now - 30_000 },
  handoffs: { value: 2, verified_at: now },
  torn: { value: 0, verified_at: now },
  inbox_open: { value: 1, verified_at: now - 8 * 60_000 },
  stuck: { value: [], verified_at: now },
  fleet: { value: [{ name: 'warden', pid: 4021, alive: true }], verified_at: now },
};

export const emptyStateFixture: ForgeState = {
  at: now,
  lanes: { value: [], verified_at: now },
  burn: { value: {}, verified_at: now },
  handoffs: { value: 0, verified_at: now },
  torn: { value: 0, verified_at: now },
  inbox_open: { value: 0, verified_at: now },
  stuck: { value: [], verified_at: now },
  fleet: { value: [], verified_at: now },
};
