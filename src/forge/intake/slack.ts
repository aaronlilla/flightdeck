/**
 * Pass to… (spec `doctrine/design/operator-experience.md` §3, roadmap R-76): one open
 * question, handed to one teammate, in one private Slack channel.
 *
 * Three rules shape everything here.
 *
 * Nothing posts without the operator's click. There is no path from a tagged question to
 * a Slack message: `postQuestion` is reachable only from the `pass` command, and a
 * question the interviewer marked `teammate` sits on the board until somebody presses
 * the button.
 *
 * The token never leaves the environment. `FORGE_SLACK_BOT_TOKEN` is read in `cli.ts`
 * and handed in; nothing in this file logs a config, journals one, or puts one in an
 * error -- the Slack error path carries the API's own `error` string and nothing else.
 *
 * Every write records its intent first. `performExternalWrite` walks
 * `intent -> call -> complete|unknown` before the sink is touched, so a post that
 * crosses with a restart is reconcilable rather than silently repeated.
 *
 * `fetch` is injected, the same way `jira.ts` injects it, so no specimen here reaches
 * the network.
 */
import { randomUUID } from 'node:crypto';

import type { Inbox, InboxEntry } from '../inbox.ts';
import { performExternalWrite } from './externalWrite.ts';
import { readabilityVerdict } from './readability.ts';
import { voiceGuard, type VoiceVerdict } from './voiceGuard.ts';

/** The environment variables this whole feature rests on. Named in every refusal, so a
 *  missing one is a sentence an operator can act on rather than a silent no-op. */
export const SLACK_ENV_VARS = ['FORGE_SLACK_BOT_TOKEN', 'FORGE_SLACK_QUESTIONS_CHANNEL', 'FORGE_SLACK_USERS'] as const;

/** Rate limit, and a limit on how much of the team's attention one board can spend: an
 *  eleventh open pass refuses rather than queueing. */
export const MAX_OPEN_PASSES = 10;

export interface SlackConfig {
  token: string;
  channel: string;
  /** Teammate name to Slack user id, read from `FORGE_SLACK_USERS` as a `Name=Uxxxx`
   *  list. Never hardcoded: a user id is workspace data, not repository data. */
  users: Record<string, string>;
  fetchFn?: typeof fetch;
}

export function parseSlackUsers(raw: string): Record<string, string> {
  const users: Record<string, string> = {};
  for (const pair of raw.split(/[\s,]+/)) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const id = pair.slice(at + 1).trim();
    if (name && id) users[name.toLowerCase()] = id;
  }
  return users;
}

/** `undefined` when any of the three variables is unset -- read fresh on every call, the
 *  same live-off-the-environment shape `jiraConfigFromEnv` keeps, so a token exported
 *  after the console started still takes effect on the next click. */
export function slackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SlackConfig | undefined {
  if (SLACK_ENV_VARS.some((name) => !env[name])) return undefined;
  return {
    token: env['FORGE_SLACK_BOT_TOKEN']!,
    channel: env['FORGE_SLACK_QUESTIONS_CHANNEL']!,
    users: parseSlackUsers(env['FORGE_SLACK_USERS']!),
  };
}

export function missingSlackEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return SLACK_ENV_VARS.filter((name) => !env[name]);
}

/** The sentence a refusal reads as on the board. One line, no jargon, and it names the
 *  variable so the fix is obvious. */
export function missingEnvSentence(missing: string[]): string {
  return `I can't pass this on: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`;
}

export type ReadabilityCheck = (text: string) => { verdict: string; reason?: string };

const defaultReadability: ReadabilityCheck = (text) => readabilityVerdict(
  'slack-question', null, '', text, undefined, new Date().toISOString().slice(0, 10),
);

export interface PostQuestionDeps {
  /** `undefined` when the environment is not configured -- refused with a sentence
   *  naming the variables, never a silent no-op. */
  config: SlackConfig | undefined;
  /** Read only to name which variables are missing in that refusal. */
  env?: NodeJS.ProcessEnv;
  inbox: Inbox;
  append: (row: { event: string; [key: string]: unknown }) => void;
  /** Both guards are injected so a specimen can prove the refusal without depending on
   *  whichever contract happens to be installed on the machine running the tests. */
  voice?: (text: string) => VoiceVerdict;
  readability?: ReadabilityCheck;
  now?: () => number;
}

export interface PassOutcome {
  ok: boolean;
  reason?: string;
  ts?: string;
}

/** How many asks are passed and still waiting on a teammate. */
export function openPassCount(inbox: Inbox): number {
  return inbox.all().filter((entry) => entry.passedTo && entry.answer === undefined).length;
}

/**
 * The message a teammate actually reads. First person, plain, one question, and it says
 * where to reply -- the voice the guard below then checks, rather than a template the
 * guard is asked to trust.
 */
export function buildPassMessage(entry: InboxEntry, name: string, userId: string): string {
  const lines = [`<@${userId}> quick one${entry.ticket ? ` on ${entry.ticket}` : ''}: ${entry.question.trim()}`];
  if (entry.options.length) {
    lines.push(entry.options.map((option, i) => `${i + 1}. ${option}`).join('  '));
  }
  lines.push('Reply in this thread and it comes back to me.');
  void name;
  return lines.join('\n');
}

/**
 * Posts one question to the questions channel and records the pass on the ask.
 *
 * Every refusal happens BEFORE `fetch` is reached: an unknown name, a guard denial and a
 * cap breach all return without a network call, which is what makes "nothing posts
 * without a click, and nothing posts that a guard would have stopped" checkable rather
 * than merely intended.
 */
export async function postQuestion(askKey: string, name: string, deps: PostQuestionDeps): Promise<PassOutcome> {
  const config = deps.config;
  if (!config) {
    const missing = missingSlackEnv(deps.env ?? process.env);
    return { ok: false, reason: missingEnvSentence(missing.length ? missing : [...SLACK_ENV_VARS]) };
  }

  const entry = deps.inbox.entry(askKey);
  if (!entry) return { ok: false, reason: `I can't pass this on: there is no open question ${askKey}.` };

  const userId = config.users[name.trim().toLowerCase()];
  if (!userId) {
    const known = Object.keys(config.users);
    return {
      ok: false,
      reason: `I can't pass this on: I don't know who ${name} is.${known.length ? ` I know ${known.join(', ')}.` : ''}`,
    };
  }

  if (!entry.passedTo && openPassCount(deps.inbox) >= MAX_OPEN_PASSES) {
    return { ok: false, reason: `I can't pass this on: ${MAX_OPEN_PASSES} questions are already out with the team.` };
  }

  const text = buildPassMessage(entry, name, userId);
  const voice = (deps.voice ?? voiceGuard)(text);
  if (!voice.ok) return { ok: false, reason: `I can't pass this on: ${voice.reason}` };
  const readable = (deps.readability ?? defaultReadability)(text);
  if (readable.verdict === 'DENY') return { ok: false, reason: `I can't pass this on: ${readable.reason}` };

  const now = deps.now ?? Date.now;
  const body = { channel: config.channel, text };
  let response: { ok?: boolean; ts?: string; error?: string } | undefined;

  const write = await performExternalWrite(
    { id: randomUUID(), kind: 'slack.question', idempotencyKey: `${askKey}:${name.toLowerCase()}` },
    async () => {
      const doFetch = config.fetchFn ?? fetch;
      const raw = await doFetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify(body),
      });
      response = await raw.json() as { ok?: boolean; ts?: string; error?: string };
    },
    (state) => {
      // `call` has no event name of its own in `FORGE_EVENT_NAMES`, and writing it as a
      // second `external.intent` row made the live journal read as two intents for one
      // post (observed 2026-09-11). The three named states are journaled; `call` is the
      // moment between them and is visible as the gap.
      const event = state === 'complete' ? 'external.complete'
        : state === 'unknown' ? 'external.unknown'
          : state === 'intent' ? 'external.intent' : null;
      if (!event) return;
      deps.append({ event, actor: 'intake', kind: 'slack.question', askKey, to: name, state });
    },
  );

  const failed = write.state !== 'complete' || !response?.ok;
  if (failed) {
    const reason = response?.error ?? write.cause ?? 'slack did not accept the post';
    deps.inbox.clearPass(askKey);
    deps.append({ event: 'slack.failed', actor: 'intake', askKey, to: name, reason });
    deps.append({ event: 'action.failed', actor: 'console', action: 'pass', askKey, to: name, reason });
    return { ok: false, reason: `I couldn't pass this on: ${reason}` };
  }

  const ts = response!.ts ?? null;
  deps.inbox.pass(askKey, name, now(), ts);
  deps.append({ event: 'ask.passed', actor: 'intake', askKey, to: name, thread: ts, ticket: entry.ticket ?? null });
  return { ok: true, ...(ts ? { ts } : {}) };
}
