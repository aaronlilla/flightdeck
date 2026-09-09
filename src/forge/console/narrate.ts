/**
 * The narration layer: one place that turns a fact record into the three registers a
 * person reads.
 *
 * Aaron, 2026-09-09: the console's sentences were hand-built templates, one register
 * each, scattered across six builders. The decision was not to rewrite those sentences by
 * hand in a nicer voice -- it was to keep the internals machine readable and produce the
 * human-facing string from them, narrated once by a cheap model, checked against the
 * facts it came from, cached on disk, and never in front of a route.
 *
 * This file is the pure half: the key, the raw register, the prompt and the reply parser.
 * The cache, the background queue, the hourly cap and the checker live next door
 * (`narrate-store.ts`, `narrate-checker.ts`) so that nothing here needs a clock, a disk
 * or a model to be tested.
 */
import { createHash } from 'node:crypto';

import type {
  NarrationFactMap, NarrationFactValue, NarrationFacts, Narrated,
} from '../../shared/console-model.js';

/**
 * Fact keys that are refused outright. Every one of them is a clock reading or something
 * derived from one, and a clock in the key is the difference between a cache that pays
 * for itself and one that costs a model call on every poll (falsifier 2 in the brief).
 * The type refuses them too (`NarrationFactMap`); this is the runtime half, because facts
 * are assembled from server records at runtime and a cast can walk past a type.
 */
export const VOLATILE_FACT_KEYS: readonly string[] = [
  'since', 'now', 'at', 'elapsed', 'elapsedMs', 'ageMs', 'age',
  'updatedAt', 'observedAt', 'verifiedAt', 'polledAt', 'renderedAt', 'ts', 'uptime',
];

export class VolatileFactError extends Error {
  constructor(public readonly key: string) {
    super(
      `narration facts may not carry ${key}: the cache is keyed by the facts, never by `
      + 'the clock. Pass a fixed clock time (HH:MM) as its own fact if the sentence needs one.',
    );
    this.name = 'VolatileFactError';
  }
}

/** Throws on any volatile key. Called by every entry point that touches a fact record. */
export function assertNarrationFacts(facts: NarrationFactMap): void {
  for (const key of Object.keys(facts)) {
    if (VOLATILE_FACT_KEYS.includes(key)) throw new VolatileFactError(key);
  }
}

/** The facts as canonical JSON: keys sorted, so the same facts written in a different
 *  order are the same cache entry rather than two model calls for one sentence. */
export function canonicalFacts(input: NarrationFacts): string {
  assertNarrationFacts(input.facts);
  const source = input.facts as Record<string, NarrationFactValue>;
  const sorted: Record<string, NarrationFactValue> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = source[key] ?? null;
  }
  return JSON.stringify({ surface: input.surface, facts: sorted });
}

/** The cache key: sha256 of the canonical facts. The template is deliberately not in the
 *  key -- rewording a template must not throw away narrations of facts that did not
 *  change, and the checker is what keeps a narration honest, not the template's wording. */
export function narrationKey(input: NarrationFacts): string {
  return createHash('sha256').update(canonicalFacts(input)).digest('hex');
}

/**
 * The `raw` register: the facts themselves, one `key: value` line each, in key order,
 * every identifier verbatim. This is what `?verbose=1` answers, and it is built from the
 * facts rather than from either sentence, so a run id the facts carried is still there.
 */
export function rawFor(input: NarrationFacts): string {
  assertNarrationFacts(input.facts);
  const facts = input.facts as Record<string, NarrationFactValue>;
  const lines = Object.keys(facts).sort().map((key) => `${key}: ${String(facts[key] ?? '')}`);
  return [`surface: ${input.surface}`, ...lines].join('\n');
}

/** What a surface serves before (or instead of) a narration: the server's own template
 *  sentence, with `narratedAt` null so the console can tell a template from a narration. */
export function templateNarration(input: NarrationFacts): Narrated {
  return {
    glance: input.template,
    detail: input.detailTemplate ?? input.template,
    raw: rawFor(input),
    narratedAt: null,
  };
}

/** A landed narration, assembled around the raw register the facts still own. */
export function narratedFrom(
  input: NarrationFacts, glance: string, detail: string, narratedAt: number,
): Narrated {
  return { glance, detail, raw: rawFor(input), narratedAt };
}

/**
 * The register rules and the examples behind them.
 *
 * The examples are the design's own copy (`doctrine/design/Flightdeck Console.dc.html`),
 * which is the register guide Aaron approved: short, concrete, no machine language, the
 * next thing to do said out loud. They use the design's fictional ticket keys so nothing
 * a real board would show is baked in as fallback copy.
 */
const FEW_SHOT: ReadonlyArray<{ facts: string; glance: string; detail: string }> = [
  {
    facts: [
      'surface: lane.now', 'kind: question', 'lane: NWR-226',
      'question: limit per user or per IP?', 'state: parked',
    ].join('\n'),
    glance: 'Asked you: limit per user or per IP? Paused until you answer.',
    detail: 'NWR-226 is paused for your answer: should the odds refresh be limited per user or per IP address? Nothing else on it moves until you say.',
  },
  {
    facts: [
      'surface: queue.whyNext', 'position: 4', 'source: Ready for Dev',
      'waitsFor: nwr-233', 'queuedAt: 09:15',
    ].join('\n'),
    glance: '4th in the queue, from a ticket in Ready for Dev. Its brief says to wait for nwr-233.',
    detail: 'It is 4th in line, picked up from Ready for Dev at 09:15, and its own brief asks it to wait for nwr-233 before it starts.',
  },
  {
    facts: [
      'surface: blocker.title', 'kind: integration', 'integration: Sentry',
      'blocks: NWR-178, NWR-155',
    ].join('\n'),
    glance: 'The Sentry token expired.',
    detail: 'Sentry stopped answering at the last health check because the token expired. NWR-178 is stopped on it and NWR-155 needs Sentry too.',
  },
];

/**
 * The prompt for one narration. Every protected token is named in it, because the checker
 * will reject a reply that drops or alters one and a rejection is cached -- telling the
 * model the rule up front is cheaper than paying for a call that can only fail.
 */
export function buildNarrationPrompt(input: NarrationFacts, protectedTokens: string[]): string {
  const examples = FEW_SHOT.map((shot, index) => [
    `Example ${index + 1} facts:`, shot.facts,
    `Example ${index + 1} answer:`,
    JSON.stringify({ glance: shot.glance, detail: shot.detail }),
  ].join('\n')).join('\n\n');

  return [
    'You write the sentences an operator reads on a fleet console. Rewrite the facts below',
    'as two sentences in the console own register: short, concrete, said the way one',
    'person tells another what happened and what to do. No machine language, no state',
    'words standing on their own, no "the system", no hedging.',
    '',
    'glance: one sentence, at most about 90 characters, the line a card shows.',
    'detail: one or two sentences, what the disclosure under it opens: the same fact with',
    'the why and the consequence, never new facts.',
    '',
    'PROTECTED TOKENS. These come from the facts and must appear in detail exactly as',
    'written here, character for character. Never change, round, reformat or invent one,',
    'and never put a number, time, ticket key or PR number in either sentence that is not',
    'in this list:',
    protectedTokens.length ? protectedTokens.map((token) => `  ${token}`).join('\n') : '  (none)',
    '',
    'Every one of them has to be in detail. A small number may be spelled as a word',
    'instead of a digit -- 3, three and third all carry 3 -- but leaving it out is not an',
    'option: a detail sentence missing one is thrown away and the operator is shown the',
    'plain template below instead of anything you write. Say the position, the count and',
    'the time even when the sentence reads more naturally without them.',
    '',
    'glance must keep every number, time, ticket key and PR number the template sentence',
    'below already says, in the same way, for the same reason.',
    '',
    'Never write a run id, an ask key, a journal id, a packet id, a process id or a',
    'forty-character commit sha in either sentence.',
    '',
    examples,
    '',
    'Facts:',
    rawFor(input),
    '',
    'The template sentence the console shows today, for register only -- do not copy it:',
    input.template,
    '',
    'Answer with one JSON object and nothing else: {"glance": "...", "detail": "..."}',
  ].join('\n');
}

export interface ParsedNarration {
  glance: string;
  detail: string;
}

const FENCE_RE = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/;

function unfence(text: string): string {
  const match = FENCE_RE.exec(text.trim());
  return match ? (match[1] ?? text) : text;
}

function asParsed(value: unknown): ParsedNarration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as { glance?: unknown; detail?: unknown; text?: unknown };
  if (typeof row.glance === 'string' && typeof row.detail === 'string') {
    return { glance: row.glance.trim(), detail: row.detail.trim() };
  }
  // `{"text": "..."}` is the shape `ClaudeReasoner` prefers; the narration is then the
  // JSON the model put inside it, fenced or not.
  if (typeof row.text === 'string') return parseNarration(row.text);
  return null;
}

/**
 * The model's reply, in any of the shapes it actually arrives in: a bare
 * `{"glance", "detail"}` object, that object inside a markdown fence, or that object as a
 * JSON string inside `{"text": ...}` (what `ClaudeReasoner`'s own system prompt asks for).
 * Anything else is null, and a null is a rejection, never a guess.
 */
export function parseNarration(reply: string): ParsedNarration | null {
  const text = unfence(reply).trim();
  if (!text) return null;
  try {
    return asParsed(JSON.parse(text));
  } catch {
    return null;
  }
}
