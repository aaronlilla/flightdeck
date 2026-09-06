/**
 * Every displayed value is verified or observed, computed per value, never per page
 * (HANDOFF "core rule: earned trust"). Verified = the feed is up AND the value's own
 * `verifiedAt` is less than `VERIFIED_WINDOW_MS` old; otherwise observed, and the
 * caller renders the dashed/phosphor-off treatment plus an "observed hh:mm" stamp.
 */
import { VERIFIED_WINDOW_MS } from '../shared/console-model.js';

export interface Freshness {
  verified: boolean;
  /** The instant this reads against: `verifiedAt` when verified, else `observedAt`. */
  at: number;
  ageMs: number;
}

/**
 * `heart` defaults to `true` for callers with no heartbeat of their own (a message's
 * `ts`, a generic `<Freshness>` readout), so they verify exactly as before. The lane
 * tile is the one caller with a real heartbeat flag (`Lane.heart`) and passes it: a
 * lane that stopped emitting heartbeats must never read "verified" just because its
 * last-known `verifiedAt` still falls inside the window. The prototype's `fresh(l)`
 * requires `l.heart` alongside the window check, and this does the same.
 */
export function computeFreshness(
  verifiedAt: number | null,
  observedAt: number,
  feedLive: boolean,
  now: number,
  heart = true,
): Freshness {
  const verified = feedLive && heart && verifiedAt !== null && now - verifiedAt < VERIFIED_WINDOW_MS;
  const at = verified ? (verifiedAt as number) : observedAt;
  return { verified, at, ageMs: Math.max(0, now - at) };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function hm(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `Ns` / `Nm` / `Nh`, matching the prototype's `ago(ms)`: seconds under a minute,
 *  minutes under an hour, hours beyond that. Used for elapsed-time reads such as
 *  "waiting 5m" that are not a clock time. */
export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

/** `✓ verified Ns ago` / `observed hh:mm`, exactly the two forms the HANDOFF names.
 *  This is the tile and ticket-sheet-band form -- the prototype's own `stamp(l)`. */
export function freshnessStamp(f: Freshness): string {
  if (f.verified) {
    const seconds = Math.round(f.ageMs / 1000);
    return `✓ verified ${seconds}s ago`;
  }
  return `observed ${hm(f.at)}`;
}

/** The rail chip / card corner form the prototype's own `msgVM` builds for every
 *  event, receipt and question card: `✓ Ns`/`✓ Nm`/`✓ Nh` while verified, `obs hh:mm`
 *  once it isn't -- shorter than `freshnessStamp`'s tile form and missing the word
 *  "verified" on purpose. */
export function compactFreshnessStamp(f: Freshness): string {
  if (f.verified) return `✓ ${ago(f.ageMs)}`;
  return `obs ${hm(f.at)}`;
}

export function freshnessClass(f: Freshness): 'stF' | 'stO' {
  return f.verified ? 'stF' : 'stO';
}
