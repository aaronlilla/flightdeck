/**
 * `GET /rounds` and `POST /rounds/apply`, and the ticker that walks the board on its own.
 *
 * `sheet()` gathers what `planRounds` (`../rounds.ts`) reads: the queue store's rows,
 * the archived-inclusive lanes view, and the blocker board as `GET /blockers` reports it.
 * `apply()` runs the mechanical findings through the queue's own functions and the one
 * retire implementation, then journals each. The route is the same path the console's
 * Rounds control and the `forge rounds` verb use, and the Conductor's `rounds` and
 * `rounds_apply` tools call these two methods and nothing else.
 *
 * The ticker runs on `conductor.rounds` in `model-policy.json`. With `apply` off (the
 * default) each tick only writes a `rounds.sheet` journal row and one rail card when the
 * findings changed since the last tick, so the operator can read what it would do before
 * letting it. With `apply` on it acts, posts a receipt per action, and hands the asks
 * that need a reading to the Conductor in one message per new batch.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { appendOnce } from '../journal.js';
import type { QueueStore } from '../intake/queueStore.js';
import { roundsConfig, type RoundsPolicy } from '../policy.js';
import {
  applyRounds, formatRoundsSheet, planRounds, type RoundsFinding, type RoundsReceipt, type RoundsSheet,
} from '../rounds.js';
import { retireLane, type RetireLaneDeps } from './retire.js';
import type { Blocker, Lane, Message } from '../../shared/console-model.js';

export interface RoundsRoutesOptions {
  store: QueueStore;
  lanesAll: () => Lane[];
  blockers: () => Promise<Blocker[]>;
  retireDeps: () => RetireLaneDeps;
  journalPath: string;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  publish: (event: Record<string, unknown>) => void;
  appendThread: (message: Message) => void;
  /** Hands a batch of asks to the Conductor. Undefined means the ticker only lists them. */
  askConductor?: (text: string) => Promise<unknown>;
  policyPath?: string;
  now?: () => number;
}

export interface RoundsApplyResult {
  sheet: RoundsSheet;
  receipts: RoundsReceipt[];
  lines: string[];
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function receiptCard(text: string): Message {
  return { k: `rounds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'receipt', text, ts: Date.now(), source: 'conductor', resolved: 'ran' };
}

/** What the Conductor is told about the asks the rules could not settle. */
export function judgeMessage(findings: RoundsFinding[]): string {
  const lines = [
    `Rounds found ${findings.length} item(s) that need a reading, not a rule. For each one: if the`,
    'question is really a completion report, or the brief or the console state already settles it,',
    'answer it with answer_ask using the suggested answer or a better one. If it needs the operator,',
    'leave it and say why in one line. Never kill or remove anything from here.',
  ];
  for (const f of findings) {
    lines.push(`- ${f.label}${f.ask?.key ? ` askKey=${f.ask.key}` : ''}${f.laneId ? ` lane=${f.laneId}` : ''}: ${f.why}`);
    if (f.ask) {
      lines.push(`  question: ${f.ask.text.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (f.ask.suggested) lines.push(`  suggested answer: ${f.ask.suggested}`);
    }
  }
  return lines.join('\n');
}

export class RoundsRoutes {
  private timer: ReturnType<typeof setInterval> | undefined;

  private lastSignature = '';

  private judgedAskKeys = new Set<string>();

  private ticking = false;

  constructor(private readonly opts: RoundsRoutesOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  policy(): RoundsPolicy {
    return roundsConfig(this.opts.policyPath);
  }

  /** How many times rounds has already relaunched an item: its `rounds:` park rows. */
  private priorRelaunches(itemId: string): number {
    return this.opts.store.history(itemId).filter((row) => typeof row.reason === 'string' && row.reason.startsWith('rounds:')).length;
  }

  async sheet(): Promise<RoundsSheet> {
    const policy = this.policy();
    const blockers = await this.opts.blockers();
    return planRounds({
      now: this.now(), items: this.opts.store.all(), lanes: this.opts.lanesAll(), blockers,
      params: {
        silentAfterMs: policy.silentMinutes * 60_000,
        orphanAfterMs: policy.orphanHours * 60 * 60_000,
        maxRelaunches: policy.maxRelaunches,
      },
      priorRelaunches: (id) => this.priorRelaunches(id),
    });
  }

  async apply(): Promise<RoundsApplyResult> {
    const sheet = await this.sheet();
    const receipts = applyRounds(sheet, {
      store: this.opts.store, now: () => this.now(),
      retire: (laneId) => {
        const outcome = retireLane(laneId, true, this.opts.retireDeps());
        return outcome.status === 200 ? { ok: true, message: outcome.body.message } : { ok: false, message: outcome.body.error };
      },
      journal: (event) => { appendOnce(this.opts.journalPath, event); },
    });
    const lines = formatRoundsSheet(sheet, 'applied');
    for (const receipt of receipts.filter((r) => r.applied)) {
      this.opts.appendThread(receiptCard(receipt.text));
    }
    this.opts.publish({ type: 'rounds.applied', at: this.now(), applied: receipts.filter((r) => r.applied).length, findings: sheet.findings.length });
    return { sheet, receipts, lines };
  }

  /** One walk. Exposed so a test fires it directly under its own clock. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const policy = this.policy();
      if (!policy.enabled) return;
      if (!policy.apply) {
        const sheet = await this.sheet();
        const signature = sheet.findings.map((f) => `${f.kind}:${f.itemId ?? f.laneId}:${f.action}`).sort().join('|');
        if (signature === this.lastSignature) return;
        this.lastSignature = signature;
        appendOnce(this.opts.journalPath, {
          event: 'rounds.sheet', actor: 'conductor', mode: 'dry-run',
          findings: sheet.findings.length, waiting: sheet.waiting.length, healthy: sheet.healthy.length,
          kinds: countKinds(sheet.findings),
        });
        if (sheet.findings.length) {
          this.opts.appendThread(receiptCard(`Rounds (dry run): ${summaryLine(sheet)}. Apply is off in conductor.rounds; run "forge rounds" to read the sheet.`));
        }
        return;
      }
      const result = await this.apply();
      appendOnce(this.opts.journalPath, {
        event: 'rounds.sheet', actor: 'conductor', mode: 'applied',
        findings: result.sheet.findings.length, applied: result.receipts.filter((r) => r.applied).length,
        waiting: result.sheet.waiting.length, healthy: result.sheet.healthy.length, kinds: countKinds(result.sheet.findings),
      });
      const toJudge = result.sheet.findings.filter((f) => f.action === 'judge' && !(f.ask?.key && this.judgedAskKeys.has(f.ask.key)));
      if (toJudge.length && this.opts.askConductor) {
        for (const f of toJudge) if (f.ask?.key) this.judgedAskKeys.add(f.ask.key);
        await this.opts.askConductor(judgeMessage(toJudge));
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    const policy = this.policy();
    if (!policy.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, policy.everyMinutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (path === '/rounds' && request.method === 'GET') {
      if (!this.opts.authorized(request, response)) return true;
      const sheet = await this.sheet();
      json(response, 200, { sheet, lines: formatRoundsSheet(sheet), policy: this.policy() });
      return true;
    }
    if (path === '/rounds/apply' && request.method === 'POST') {
      if (!this.opts.authorized(request, response)) return true;
      const result = await this.apply();
      json(response, 200, { ok: true, applied: result.receipts.filter((r) => r.applied).length, receipts: result.receipts, lines: result.lines });
      return true;
    }
    return false;
  }
}

function countKinds(findings: RoundsFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

function summaryLine(sheet: RoundsSheet): string {
  const kinds = countKinds(sheet.findings);
  const parts = Object.entries(kinds).map(([k, n]) => `${n} ${k.replace(/-/g, ' ')}`);
  return `${sheet.findings.length} finding(s): ${parts.join(', ')}; ${sheet.waiting.length} waiting on a real blocker, ${sheet.healthy.length} healthy`;
}
