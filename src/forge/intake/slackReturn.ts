/**
 * The reply comes back on its own (roadmap R-76): one `conversations.replies` read per
 * open pass per poll tick, and the teammate's answer lands on the ask that was passed.
 *
 * What this deliberately does NOT do is decide anything. A teammate replies in prose,
 * and prose is not an option: the reply is attached with `answeredBy` naming who typed
 * it, the ask stays OPEN, and the operator confirms or changes it from the board. A
 * machine that mapped "yeah probably the second one" onto option 2 would be inventing a
 * decision nobody made.
 *
 * A reply from somebody else in the thread is kept as a note, never as the answer.
 */
import type { PollSourceName, Watermark } from '../contracts.ts';
import type { Inbox, InboxEntry } from '../inbox.ts';
import { runPoll, type RawPollItem } from './poller.ts';
import { postThreadReply, type SlackConfig } from './slack.ts';

export const SLACK_SOURCE: PollSourceName = 'slack';

export interface SlackReturnDeps {
  config: SlackConfig | undefined;
  inbox: Inbox;
  append: (row: { event: string; [key: string]: unknown }) => void;
  /** Posts the one-sentence acknowledgement back into the thread. Injected so a specimen
   *  never posts, and so a failure here can be exercised without a network. */
  acknowledge?: (thread: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Whether a reply can be read as one of the options, and which.
 *
 * This decides WHAT TO SAY BACK, never what the answer is. The answer stays the person's
 * own words and the ask stays open for the operator either way -- reading "1" as the
 * first option here would be a courtesy in a sentence, not a decision recorded anywhere.
 */
export function optionMatching(options: string[], reply: string): string | undefined {
  const trimmed = reply.trim();
  if (!trimmed) return undefined;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1];
  }
  const lower = trimmed.toLowerCase();
  return options.find((option) => {
    const candidate = option.trim().toLowerCase();
    return candidate.length > 0 && (lower === candidate || lower.includes(candidate));
  });
}

/**
 * The sentence the teammate reads back.
 *
 * The question is named in plain words rather than by its ticket id: the person answering
 * is outside this repository and a bare `R-76` means nothing to them.
 */
export function buildAckMessage(entry: InboxEntry, reply: string): string {
  const question = entry.question.split('\n')[0]!.trim();
  const head = question.length > 80 ? `${question.slice(0, 80).trimEnd()}…` : question;
  const matched = optionMatching(entry.options, reply);
  if (matched) {
    return `Got it, thanks — "${matched}" on "${head}". I'll carry on from here.`;
  }
  return `Got it, thanks. I can't tell which of the options that maps to, so I'll read it myself rather than guess at "${head}".`;
}

export interface SlackReturnResult {
  watermark: Watermark;
  /** One row per reply this poll attached as an answer. */
  attached: { askKey: string; from: string; text: string; thread: string }[];
  /** One row per reply from somebody the question was not passed to. */
  notes: { askKey: string; from: string }[];
  /** True when every `conversations.replies` call this poll made came back `ok`. */
  ok: boolean;
}

interface SlackReply {
  user?: string;
  text?: string;
  ts?: string;
}

/** Every ask that is out with a teammate and has not heard back. */
export function openPasses(inbox: Inbox): InboxEntry[] {
  return inbox.all().filter((entry) => entry.passedThread && !entry.answeredBy && entry.answer === undefined);
}

function nameFor(config: SlackConfig, userId: string): string | undefined {
  const found = Object.entries(config.users).find(([, id]) => id === userId);
  if (!found) return undefined;
  const [lower] = found;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * One poll over every open pass. Returns the advanced watermark; the caller persists it,
 * exactly as `runPoll` already requires, so a crash before that leaves the prior
 * watermark in force and the reply is read again rather than lost.
 *
 * A Slack call that comes back `ok: false` leaves the watermark exactly where it was --
 * a refused read is not evidence that there was nothing to read.
 */
export async function readSlackReplies(mark: Watermark, deps: SlackReturnDeps): Promise<SlackReturnResult> {
  const config = deps.config;
  const open = openPasses(deps.inbox);
  if (!config || !open.length) return { watermark: mark, attached: [], notes: [], ok: true };

  const rows: { item: RawPollItem; entry: InboxEntry; reply: SlackReply }[] = [];
  const notes: { askKey: string; from: string }[] = [];
  let ok = true;

  for (const entry of open) {
    const doFetch = config.fetchFn ?? fetch;
    const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(config.channel)}`
      + `&ts=${encodeURIComponent(entry.passedThread!)}&limit=50`;
    let payload: { ok?: boolean; messages?: SlackReply[]; error?: string };
    try {
      const raw = await doFetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
      payload = await raw.json() as typeof payload;
    } catch (error) {
      ok = false;
      deps.append({ event: 'slack.failed', actor: 'intake', askKey: entry.key, reason: (error as Error).message });
      continue;
    }
    if (!payload.ok) {
      ok = false;
      deps.append({ event: 'slack.failed', actor: 'intake', askKey: entry.key, reason: payload.error ?? 'replies refused' });
      continue;
    }
    // The first message in a thread is the question itself, never an answer to it.
    const replies = (payload.messages ?? []).slice(1);
    for (const reply of replies) {
      if (!reply.ts || !reply.user) continue;
      const passedId = config.users[(entry.passedTo ?? '').toLowerCase()];
      if (reply.user !== passedId) {
        // Somebody else weighing in is worth knowing about and is never the answer: the
        // question was put to one person, and a thread is not a vote.
        notes.push({ askKey: entry.key, from: reply.user });
        continue;
      }
      rows.push({ item: { id: `${entry.key}:${reply.ts}`, updated: Number(reply.ts) * 1000 }, entry, reply });
    }
  }

  if (!ok) return { watermark: mark, attached: [], notes, ok: false };

  const attached: { askKey: string; from: string; text: string; thread: string }[] = [];
  const byId = new Map(rows.map((row) => [`${SLACK_SOURCE}:${row.item.id}:${row.item.updated}`, row]));
  const result = await runPoll(
    { name: SLACK_SOURCE, fetchSince: async () => rows.map((row) => row.item) },
    mark,
    (event) => {
      const row = byId.get(event.key);
      if (!row) return;
      // The first reply that reaches here wins: a teammate who types twice has not
      // answered twice.
      if (row.entry.answeredBy || attached.some((a) => a.askKey === row.entry.key)) return;
      const from = nameFor(config, row.reply.user!) ?? row.reply.user!;
      const text = (row.reply.text ?? '').trim();
      deps.inbox.attachReply(row.entry.key, from, text);
      deps.append({
        event: 'ask.returned', actor: 'intake', askKey: row.entry.key, from,
        thread: row.entry.passedThread, ticket: row.entry.ticket ?? null,
      });
      attached.push({ askKey: row.entry.key, from, text, thread: row.entry.passedThread! });
    },
  );

  // The acknowledgement goes out after the answer is attached, never before: a failed
  // acknowledgement must not un-attach an answer that did arrive. Once per attached
  // reply, and the watermark that stops a reply being read twice is what stops this being
  // said twice.
  for (const row of attached) {
    const entry = deps.inbox.entry(row.askKey);
    if (!entry) continue;
    const send = deps.acknowledge
      ?? ((thread: string, text: string) => postThreadReply(thread, text, { config, append: deps.append }));
    const outcome = await send(row.thread, buildAckMessage(entry, row.text));
    if (outcome.ok) continue;
    // Worth a row and nothing more. The answer is already recorded; the only thing lost
    // is the courtesy, and un-winding the answer over it would be far worse.
    deps.append({
      event: 'slack.failed', actor: 'intake', askKey: row.askKey,
      reason: `acknowledgement not delivered: ${outcome.reason ?? 'unknown'}`,
    });
  }

  return { watermark: result.watermark, attached, notes, ok: true };
}
