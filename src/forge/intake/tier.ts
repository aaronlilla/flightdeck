/**
 * Complexity routing: the planner predicts each ticket's tier ONCE, at planning time,
 * and this module is what turns that prediction (or the absence of one) into the exact
 * `tier: <x>` line every brief this queue writes carries -- ticket-via-interview,
 * pasted brief, and typed hotfix alike (Aaron, opt/tier). No env flag turns this off:
 * every brief `queue-wire.ts`'s own `writeBrief` persists to disk goes through
 * `decideTier`/`withTierLine` first, so a ticket the planner never reasoned about (a
 * pasted brief, a reasoner failure) still gets a tier -- `standard`, never skipped.
 *
 * `escalation: never-by-retry` (model-policy.json's own rule) holds here for a reason
 * specific to this module: `decideTier` takes only the text in front of it, never a run's
 * history, so a retried item re-reads the SAME stored brief and gets the SAME tier every
 * time. Nothing here ever escalates on a failure or a retry, because nothing here ever
 * sees one.
 */
export type Tier = 'light' | 'standard' | 'hard';

/**
 * The deterministic guardrail (code, not a prompt): a ticket whose text touches money,
 * a ledger, a wallet, a payment or an auth/security surface never rides on Haiku, however
 * confidently the planner called it "light". Matched case-insensitively as whole words
 * (`\b`) so "cardigan" does not trip "card" -- a false upgrade to `standard` costs nothing,
 * but a false one on `hard` would need a second list, and `light` is the only tier this
 * guardrail ever overrides.
 */
export const MONEY_AUTH_KEYWORDS = [
  'millicent', 'ledger', 'wallet', 'sila', 'synkros', 'withdraw', 'deposit', 'payment',
  'card', 'auth', 'token', 'password', 'kyc', 'ssn',
] as const;

/** The first money/auth keyword found in `text`, or undefined when none matches. Matched
 *  as a whole word so "cardigan" does not trip "card"; "millicent" and "kyc" still match
 *  as whole words inside ordinary prose. */
export function matchedGuardrailKeyword(text: string): string | undefined {
  const lower = text.toLowerCase();
  return MONEY_AUTH_KEYWORDS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
}

const VALID_TIERS: readonly Tier[] = ['light', 'standard', 'hard'];

/** Any string down to a real `Tier`, or undefined for anything this rubric never emits. */
function asTier(raw: string | null | undefined): Tier | undefined {
  const lower = (raw ?? '').trim().toLowerCase();
  return (VALID_TIERS as readonly string[]).includes(lower) ? (lower as Tier) : undefined;
}

/** `tier: <x>` and its optional `tier-reason: <text>` line, read from anywhere in a brief
 *  (or a plain ticket description) the same forgiving way `policy.ts#tierOfBrief` reads
 *  its own tier line -- a whole line, not a substring inside an argumentative sentence. */
const TIER_LINE = /^[ \t]*(?:-[ \t]*)?tier[ \t]*:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/im;
const TIER_REASON_LINE = /^[ \t]*(?:-[ \t]*)?tier-reason[ \t]*:[ \t]*(.+?)[ \t]*$/im;

export function parseTierLine(text: string): { tier: string; reason?: string } | null {
  const found = TIER_LINE.exec(text ?? '');
  if (!found?.[1]) return null;
  const reasonFound = TIER_REASON_LINE.exec(text ?? '');
  return { tier: found[1], ...(reasonFound?.[1] ? { reason: reasonFound[1] } : {}) };
}

export interface TierDecision {
  tier: Tier;
  reason: string;
}

/**
 * The one place a ticket's tier gets decided. `reportedTier` is whatever the planner
 * (or an operator's own `tier:` line) claimed; missing or not one of the three real
 * tiers falls back to `standard` -- routing never skips for want of a clean signal.
 * `text` is read for the guardrail keywords regardless of what was reported: a `light`
 * call on a ticket that says "reset the withdraw limit" is upgraded to `standard`
 * whoever or whatever wrote `light`.
 */
export function decideTier(input: { reportedTier?: string | null; reason?: string; text: string }): TierDecision {
  const parsed = asTier(input.reportedTier);
  if (!parsed) {
    return { tier: 'standard', reason: 'no valid tier was reported; defaulted to standard' };
  }
  if (parsed === 'light') {
    const keyword = matchedGuardrailKeyword(input.text);
    if (keyword) {
      return {
        tier: 'standard',
        reason: `guardrail: "${keyword}" (money/auth) upgraded light to standard`,
      };
    }
  }
  return { tier: parsed, reason: input.reason?.trim() || `planner called this ${parsed}` };
}

/**
 * Writes (or rewrites) the `tier: <x>` / `tier-reason: <...>` lines into a brief's text.
 * A brief that already carries the lines gets them replaced in place, right where they
 * were -- so a guardrail upgrade never duplicates the line. A brief with none gets them
 * inserted directly under its first heading (or at the very top, for a brief with no
 * heading at all), which is also where a hand-typed `tier: opus` line already lived.
 */
export function withTierLine(text: string, tier: Tier, reason: string): string {
  const tierLine = `tier: ${tier}`;
  const reasonLine = `tier-reason: ${reason}`;
  if (TIER_LINE.test(text)) {
    let next = text.replace(TIER_LINE, tierLine);
    next = TIER_REASON_LINE.test(next)
      ? next.replace(TIER_REASON_LINE, reasonLine)
      : next.replace(tierLine, `${tierLine}\n${reasonLine}`);
    return next;
  }
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#\s/.test(line));
  const insertAt = headingIndex >= 0 ? headingIndex + 1 : 0;
  lines.splice(insertAt, 0, '', tierLine, reasonLine);
  return lines.join('\n');
}

/** One call: read whatever tier the brief already reports, apply the guardrail, and
 *  hand back the finished text plus the decision so the caller can journal it. Never
 *  skips -- a brief with no tier line at all still comes back with `standard`. */
export function ensureTierLine(text: string): { text: string; decision: TierDecision } {
  const parsed = parseTierLine(text);
  const decision = decideTier({ reportedTier: parsed?.tier, reason: parsed?.reason, text });
  return { text: withTierLine(text, decision.tier, decision.reason), decision };
}
