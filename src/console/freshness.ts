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

export function computeFreshness(
  verifiedAt: number | null,
  observedAt: number,
  feedLive: boolean,
  now: number,
): Freshness {
  const verified = feedLive && verifiedAt !== null && now - verifiedAt < VERIFIED_WINDOW_MS;
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

/** `✓ verified Ns ago` / `observed hh:mm`, exactly the two forms the HANDOFF names. */
export function freshnessStamp(f: Freshness): string {
  if (f.verified) {
    const seconds = Math.round(f.ageMs / 1000);
    return `✓ verified ${seconds}s ago`;
  }
  return `observed ${hm(f.at)}`;
}

export function freshnessClass(f: Freshness): 'stF' | 'stO' {
  return f.verified ? 'stF' : 'stO';
}
