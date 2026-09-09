/**
 * The referee between a narration and the facts it came from.
 *
 * A model that writes a nicer sentence is worth nothing if it can quietly change a PR
 * number, round a count, move a clock time or swap a state word: the operator reads the
 * pretty version and acts on a fact that is not true. So every candidate is checked
 * against the fact record before it is ever served, the template stands in when the check
 * fails, and the rejection is cached so the same facts are never paid for twice
 * (`escalation: never-by-retry`).
 *
 * The rules, in the order they fire:
 *   1. Neither register carries a run id, an ask key, a journal id, a packet id, a pid or
 *      a forty-character sha -- the same identifier shapes `humanize.ts` strips.
 *   2. `detail` carries every protected token the facts carry.
 *   3. Neither register carries a number, time, ticket key or PR number that the facts and
 *      the template do not.
 *   4. `glance` carries every protected token its own template sentence carries.
 */
import type { NarrationFacts, NarrationFactValue } from '../../shared/console-model.js';

import { assertNarrationFacts } from './narrate.js';

export type NarrationRegister = 'glance' | 'detail';

export interface NarrationVerdict {
  ok: boolean;
  /** The first offending token, named. Null only when `ok`. */
  token: string | null;
  register: NarrationRegister | null;
  /** Which rule fired, for the journal row and the specimen sheet. */
  rule: 'missing-token' | 'invented-token' | 'machine-id' | 'empty' | null;
  reason: string;
}

const OK: NarrationVerdict = { ok: true, token: null, register: null, rule: null, reason: 'accepted' };

/** The identifier shapes that must never reach a person, borrowed from `humanize.ts`
 *  rather than re-guessed: a rule written twice drifts, and the drifted copy is the one
 *  that lets an id through. */
const MACHINE_ID_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'run id', re: /(?<![/-])\bS-[0-9a-f]{12,}\b(?:-\d+)?/ },
  { name: 'run id', re: /(?<![/-])\bjira_[A-Z]{2,6}-\d+_\d{10,}(?:-\d+)?\b/ },
  { name: 'run id', re: /(?<![/-])\bqueue-brief-\d{10,}(?:-\d+)?\b/ },
  { name: 'journal id', re: /\bJ-[0-9a-f]{6,}\b/ },
  { name: 'commit sha', re: /\b[0-9a-f]{40}\b/ },
  // The guards name the ids already reported above rather than the character `-`, which
  // an ordinary id prefix uses too: `packet-a1b2...` used to slip past this rule entirely.
  { name: 'ask or packet key', re: /(?<!\/)(?<!S-)(?<!J-)(?<!jira_)\b[0-9a-f]{16,39}\b/ },
  { name: 'process id', re: /\b(?:pid|process(?:\s+id)?)\s*[:=]?\s*\d+\b/i },
];

const URL_RE = /https?:\/\/\S+/g;
const TICKET_RE = /(?<![A-Za-z])[A-Z]{2,6}-\d+(?!\d)/g;
const PR_RE = /#\d+/g;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
/** A number written with thousands separators is one token. Masked before `NUMBER_RE`,
 *  which would otherwise read `1,234` as `1` and `234` -- two half-facts, one of which a
 *  wrong number still carries. The console writes token counts and ceilings this way. */
const GROUPED_RE = /\b\d{1,3}(?:,\d{3})+\b/g;
/** A calendar date is one token, not the year alone. Masked before `NUMBER_RE` runs, so
 *  `2026-09-09` cannot be checked as `2026` with the month and the day free to change. */
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
/**
 * A bare number.
 *
 * The lookbehind deliberately does not exclude a preceding `-`. It used to, and a
 * critique of this file found what that cost: every shape where a digit run follows a
 * hyphen lost all but its first group -- `10-20ms` was checked as `10` with the upper
 * bound free to be anything, and `-5` was not checked at all. URLs, ticket keys, PR
 * refs, clock times and dates are all masked out before this pattern runs, so a `-` in
 * front of a digit here is a minus sign or a range separator, and both ends of a range
 * are facts.
 *
 * The trailing guard is `(?!\.\d)` rather than `(?![\d.:])` for the same reason: a number
 * that ends a sentence is followed by the sentence's own full stop, and the old guard
 * threw the whole token away -- `the fee was 3.14.` protected nothing at all.
 */
const NUMBER_RE = /(?<![\d.:\w])\d+(?:\.\d+)*(?![\d:])(?!\.\d)/g;

/** Fact keys whose string value is a person's or an owner's name, kept verbatim. */
const NAME_KEY_RE = /^(owner|who|whoName|person|assignee|author|reviewer|holder)$/i;
/** Fact keys whose value is a state or kind word, kept verbatim. */
const WORD_KEY_RE = /^(state|kind|status|verdict|hop|hopStatus|checks|source)$/i;

function matchesOf(text: string, re: RegExp): string[] {
  return text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? [];
}

/**
 * Every token in a piece of text that a narration is not allowed to invent or lose:
 * URLs, ticket keys, PR references, clock times, dates, grouped numbers and bare
 * numbers. Extracted in that order, each match masked out before the next pattern
 * runs, so the `15` inside `09:15`
 * and the `96` inside `NWR-96` are never mistaken for numbers of their own.
 */
export function protectedTokensIn(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const re of [URL_RE, TICKET_RE, PR_RE, TIME_RE, DATE_RE, GROUPED_RE, NUMBER_RE]) {
    for (const token of matchesOf(rest, re)) found.push(token);
    rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ');
  }
  return found;
}

/** The protected tokens of a whole fact record: every value's own tokens, plus the
 *  verbatim value of any state, kind or person fact. */
export function protectedTokensFor(input: NarrationFacts): string[] {
  assertNarrationFacts(input.facts);
  const facts = input.facts as Record<string, NarrationFactValue>;
  const out: string[] = [];
  for (const key of Object.keys(facts).sort()) {
    const value = facts[key];
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (!text.trim()) continue;
    if (typeof value === 'number') {
      out.push(text);
      continue;
    }
    if (typeof value === 'string' && (NAME_KEY_RE.test(key) || WORD_KEY_RE.test(key))) {
      out.push(text);
    }
    // A fact whose value is itself a machine id contributes no protected tokens. It is in
    // the record so `raw` can carry it verbatim, and the `machine-id` rule forbids it
    // reaching either sentence -- requiring its digits as well would be asking the
    // narration for a token the next rule rejects it for using. (Found 2026-09-09, when
    // widening `NUMBER_RE` made the digits inside `S-81782ab6...` visible for the first
    // time and the parked specimen started demanding its own run id.)
    if (MACHINE_ID_PATTERNS.some(({ re }) => re.test(text))) continue;
    for (const token of protectedTokensIn(text)) out.push(token);
  }
  return [...new Set(out)];
}

/** The word forms of the small integers the console actually counts in. A sentence a person
 *  would write says "third in the queue", not "3 in the queue", and the design's own copy
 *  does exactly that -- so `position: 3` is carried by `3`, `third` or `three`, and by
 *  nothing else. Above twelve the design writes the digits, so the table stops there. */
const CARDINALS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];
const ORDINALS = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
];

/** A fact and the surface forms that count as carrying it. `412` and `#412` are the same
 *  pull request written two ways; treating them as different tokens would reject the
 *  design's own sentence for saying `PR #412`. */
function variantsOf(token: string): string[] {
  const bare = token.startsWith('#') ? token.slice(1) : token;
  if (!/^\d+$/.test(bare)) return [token];
  const out = [bare, `#${bare}`];
  const n = Number(bare);
  if (n < CARDINALS.length) out.push(CARDINALS[n] as string, ORDINALS[n] as string);
  return out;
}

/** Two tokens naming the same fact share this key, so the invented-token rule does not
 *  fire on a candidate that wrote `#412` where the facts wrote `412`. */
function factKey(token: string): string {
  return token.startsWith('#') ? token.slice(1) : token;
}

/** Verbatim containment with a boundary, so `15` does not count as present because the
 *  candidate happens to say `09:15`, and `NWR-9` is not satisfied by `NWR-96`. */
function carries(candidate: string, token: string): boolean {
  return variantsOf(token).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leading = /^[\w#]/.test(form) ? '(?<![\\w:.#-])' : '';
    // A sentence-final period must not hide the token in front of it, so `.` and `:` only
    // block when a digit follows them: `09:15.` carries 09:15, `09:151` does not.
    const trailing = /[\w]$/.test(form) ? '(?![\\w-]|[:.]\\d)' : '';
    return new RegExp(`${leading}${escaped}${trailing}`, 'i').test(candidate);
  });
}

function machineIdIn(text: string): { token: string; name: string } | null {
  for (const { name, re } of MACHINE_ID_PATTERNS) {
    const match = re.exec(text);
    if (match) return { token: match[0], name };
  }
  return null;
}

/**
 * Checks one candidate narration against its facts. Returns the first offending token
 * with the register and rule that rejected it; the caller serves the template and caches
 * the rejection.
 */
export function checkNarration(
  input: NarrationFacts, candidate: { glance: string; detail: string },
): NarrationVerdict {
  const glance = candidate.glance.trim();
  const detail = candidate.detail.trim();
  if (!glance || !detail) {
    return {
      ok: false, token: null, register: glance ? 'detail' : 'glance', rule: 'empty',
      reason: 'a register came back empty',
    };
  }

  for (const register of ['glance', 'detail'] as const) {
    const found = machineIdIn(register === 'glance' ? glance : detail);
    if (found) {
      return {
        ok: false, token: found.token, register, rule: 'machine-id',
        reason: `${register} carries a ${found.name} (${found.token}); internals stay out of a person's sentence`,
      };
    }
  }

  const factTokens = protectedTokensFor(input);
  for (const token of factTokens) {
    if (!carries(detail, token)) {
      return {
        ok: false, token, register: 'detail', rule: 'missing-token',
        reason: `detail dropped or altered ${token}, which the facts carry`,
      };
    }
  }

  const templateTokens = protectedTokensIn(input.template);

  // Invented before dropped, on purpose. A register that both loses a fact and makes one
  // up is worse for the invention: a missing number reads as vague, a wrong number reads
  // as true. So the operator is told about the number that is not real first.
  const allowed = new Set([...factTokens, ...templateTokens].map(factKey));
  for (const register of ['glance', 'detail'] as const) {
    for (const token of protectedTokensIn(register === 'glance' ? glance : detail)) {
      if (!allowed.has(factKey(token))) {
        return {
          ok: false, token, register, rule: 'invented-token',
          reason: `${register} invented ${token}, which is in neither the facts nor the template`,
        };
      }
    }
  }

  for (const token of templateTokens) {
    if (!carries(glance, token)) {
      return {
        ok: false, token, register: 'glance', rule: 'missing-token',
        reason: `glance dropped or altered ${token}, which its own template sentence carries`,
      };
    }
  }

  return OK;
}
