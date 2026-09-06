/**
 * The fixture server the UI, the vitest App test and the Playwright suite all
 * run against until the real routes land in `src/forge/server.ts` (S2/S3).
 * Serves every route in `src/shared/console-model.ts` from the seed fixtures
 * under `src/console/fixtures/`, mutating them in memory so a write behaves
 * the way the real server is meant to: kill kills, caps refuse above the hard
 * limit, an answer resumes a parked lane.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { HEARTBEAT_MS } from '../shared/console-model.js';
import type {
  ActionResult, Caps, Integration, JournalEntry, Lane, Message, QueueAddRequest, QueueAddResponse,
  QueueItem, QueueSource, Rule,
} from '../shared/console-model.js';
import { seedCaps } from './fixtures/caps.js';
import { seedIntegrations } from './fixtures/integrations.js';
import { seedJournal } from './fixtures/journal.js';
import { seedLanes } from './fixtures/lanes.js';
import { seedRules } from './fixtures/proposals.js';
import { seedThread } from './fixtures/thread.js';

// `import.meta.url` is not always a `file:` URL under every test environment
// (jsdom's module graph rewrites it); this only ever needs to resolve when
// something actually asks for a static asset, so a bad URL here falls back
// to the working directory instead of failing every route in the file.
function distDir(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    return join(here, '..', '..', 'dist', 'console');
  } catch {
    return join(process.cwd(), 'dist', 'console');
  }
}
const DIST_DIR = distDir();
const PORT = Number(process.env['FORGE_STUB_PORT'] ?? 4130);
const TOKEN = process.env['FORGE_STUB_TOKEN'] ?? 'stub-token';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

interface Db {
  lanes: Lane[];
  thread: Message[];
  journal: JournalEntry[];
  integrations: Integration[];
  caps: Caps;
  rules: Rule[];
  jn: number;
  queue: QueueItem[];
  queuePaused: boolean;
  qn: number;
}

function seedDb(): Db {
  return {
    lanes: seedLanes(),
    thread: seedThread(),
    journal: seedJournal(),
    integrations: seedIntegrations(),
    caps: seedCaps(),
    rules: seedRules(),
    jn: 40221,
    queue: [],
    queuePaused: false,
    qn: 0,
  };
}

let db = seedDb();

function nextJid(): string {
  db.jn += 1;
  return `J-${db.jn}`;
}

function journal(kind: string, text: string, run: string | null, undoable: boolean): string {
  const jid = nextJid();
  db.journal = [{ jid, ts: Date.now(), kind, text, actor: 'console', run, undoable, undone: false }, ...db.journal];
  return jid;
}

function appendEvent(text: string, lane?: string): void {
  db.thread = [...db.thread, { k: `evt-${Date.now()}-${Math.random()}`, type: 'event', text, ts: Date.now(), source: 'system', lane, verifiedAt: Date.now() }];
}

function findLane(id: string): Lane | undefined {
  return db.lanes.find((l) => l.id === id);
}

/** A per-step cost breakdown built from the fixture lane's own turn count, the closest
 *  the stub can get to the real server's per-turn usage rows without a real journal. */
function stubCostSteps(lane: Lane): { t: number; stepText: string; inputTokens: number; outputTokens: number; costUsd: number }[] {
  const n = Math.max(1, lane.stepN);
  const steps = [];
  for (let i = 1; i <= n; i += 1) {
    const runaway = lane.runaway && i === n;
    const frac = runaway ? 0.92 : 1 / n;
    steps.push({
      t: lane.startedAt + i * 8 * 60_000,
      stepText: runaway ? `retry loop · ${lane.fails} failed builds` : `step ${i}/${lane.stepTotal}`,
      inputTokens: Math.round(lane.costUsd * frac * 3400),
      outputTokens: Math.round(lane.costUsd * frac * 900),
      costUsd: Number((lane.costUsd * frac).toFixed(2)),
    });
  }
  return steps;
}

/** The ticket sheet's journal narrative, built the same shape the real server computes
 *  from the journal (see `src/forge/console/journal-narrative.ts`), off this fixture
 *  lane's own fields since the stub has no real journal to read from. */
function stubJournalNarrative(lane: Lane): { t: number; text: string; color: string }[] {
  const entries: { t: number; text: string; color: string }[] = [
    { t: lane.startedAt, text: `polled ${lane.id} from queue`, color: 'var(--ink2)' },
  ];
  if (!lane.sandbox) {
    entries.push({ t: lane.startedAt + 60_000, text: 'provision failed · AWS sandboxes disconnected', color: 'var(--block)' });
  } else {
    entries.push({ t: lane.startedAt + 60_000, text: `sandbox ${lane.sandbox.id} provisioned`, color: 'var(--ink2)' });
    entries.push({ t: lane.startedAt + 180_000, text: `branch ${lane.id.toLowerCase()} pushed · ${lane.model}`, color: 'var(--ink2)' });
  }
  if (lane.hop >= 3) entries.push({ t: lane.since - 60_000, text: 'gate opened · council judge ×3', color: 'var(--ink2)' });
  if (lane.state === 'parked') entries.push({ t: lane.since, text: 'parked — needs human', color: 'var(--park)' });
  else if (lane.state === 'merged') entries.push({ t: lane.since, text: 'merged → main · jira updated', color: 'var(--merge)' });
  else if (lane.state === 'killed') entries.push({ t: lane.since, text: 'killed · diff discarded', color: 'var(--block)' });
  else if (lane.runaway) entries.push({ t: Date.now(), text: `build failing ×${lane.fails} · $${lane.costUsd.toFixed(2)}`, color: 'var(--block)' });
  return entries;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readBody(request);
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function ok(jid: string, message: string, undoable: boolean, lane?: Lane): ActionResult {
  return { ok: true, jid, message, undoable, lane };
}

function newQueueItem(source: QueueSource, input: string, ticket: string | null): QueueItem {
  db.qn += 1;
  const now = Date.now();
  return {
    id: `Q-stub-${db.qn}`, source, input, ticket, repo: null, briefPath: null, branch: null,
    worktreePath: null, base: null, state: 'queued', reason: null, runKey: null, pr: null,
    journalIds: [], createdAt: now, updatedAt: now,
  };
}

/** The stub's own stand-in for a real JQL search: deterministic, no network, two ticket
 *  keys derived from the query text so a `query`/`backlog` add has something to show. */
function fakeSearchKeys(jql: string): string[] {
  const slug = jql.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, 12) || 'ITEM';
  return [`${slug}-1`, `${slug}-2`];
}

/**
 * The stub's own fake worker: a real `forge up` plans, provisions, launches and gates an
 * item through `intake/queue.ts#advanceItem` against real dependencies; this stub has
 * none of those, so it simulates the same three hops on a short timer instead --
 * `queued` -> `running` -> `review`, with a fake draft PR -- so the console's own queue
 * view can be driven end to end (add an item, watch it land in review) with nothing
 * behind it but this fixture.
 */
function fakeAdvance(item: QueueItem): void {
  setTimeout(() => {
    const row = db.queue.find((q) => q.id === item.id);
    if (!row || row.state !== 'queued') return;
    row.state = 'running';
    row.repo = 'example/repo';
    row.updatedAt = Date.now();
  }, 400);
  setTimeout(() => {
    const row = db.queue.find((q) => q.id === item.id);
    if (!row || row.state !== 'running') return;
    db.qn += 1;
    row.state = 'review';
    row.pr = { no: db.qn, url: `https://github.com/example/repo/pull/${db.qn}`, files: 3, add: 42, del: 6, draft: true };
    row.updatedAt = Date.now();
  }, 1200);
}

function addQueueItem(body: QueueAddRequest): QueueAddResponse {
  if (!body || !body.input || !body.input.trim()) {
    return { ok: false, items: [], error: 'a queue add needs a source and input' };
  }
  if (body.source === 'ticket') {
    const item = newQueueItem('ticket', body.input.trim(), body.input.trim());
    db.queue = [...db.queue, item];
    fakeAdvance(item);
    return { ok: true, items: [item] };
  }
  if (body.source === 'brief') {
    const item = newQueueItem('brief', body.input, null);
    db.queue = [...db.queue, item];
    fakeAdvance(item);
    return { ok: true, items: [item] };
  }
  if (body.source === 'query' || body.source === 'backlog') {
    const items = fakeSearchKeys(body.input).map((key) => newQueueItem(body.source, body.input, key));
    db.queue = [...db.queue, ...items];
    for (const item of items) fakeAdvance(item);
    return { ok: true, items };
  }
  return { ok: false, items: [], error: `unknown source ${String(body.source)}` };
}

function serveStatic(request: IncomingMessage, response: ServerResponse, urlPath: string): void {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const full = join(DIST_DIR, relative);
  if (!full.startsWith(DIST_DIR) || !existsSync(full)) {
    json(response, 404, { error: `nothing serves ${urlPath}. Did you run npm run console:build?` });
    return;
  }
  let text = readFileSync(full, 'utf8');
  if (extname(full) === '.html') {
    text = text.replace('<meta name="forge-token" content="" />', `<meta name="forge-token" content="${TOKEN}" />`);
  }
  const mime = MIME[extname(full)] ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': mime });
  response.end(text);
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

const sockets = new Set<Duplex>();

function publish(event: Record<string, unknown>): void {
  const frame = textFrame(JSON.stringify(event));
  for (const socket of [...sockets]) {
    try { socket.write(frame); } catch { sockets.delete(socket); }
  }
}

function runCommand(text: string): Message[] {
  const t = text.trim();
  const now = Date.now();
  const laneRefMatch = /\b([a-z]{2,4}-\d{2,4})\b/i.exec(t);
  const laneRef = laneRefMatch ? (laneRefMatch[1] as string).toUpperCase() : null;

  if (/^confirm /i.test(t)) return []; // handled client-side against the local confirm card
  if (/^kill\b/i.test(t) && laneRef) {
    const lane = findLane(laneRef);
    if (!lane) return [{ k: `c-${now}`, type: 'refusal', text: `no lane named ${laneRef}`, ts: now, source: 'conductor' }];
    return [{
      k: `confirm-${now}`, type: 'confirm', text: `Kill ${laneRef}?`, ts: now, source: 'conductor',
      blast: 'discards the working diff and stops the sandbox.',
    }];
  }
  if (/^merge ready lanes/i.test(t)) {
    const ready = db.lanes.filter((l) => l.state === 'done');
    if (ready.length === 0) return [{ k: `c-${now}`, type: 'reply', text: 'no lanes are ready to merge.', ts: now, source: 'conductor' }];
    return [{
      k: `plan-${now}`, type: 'plan', text: 'merge ready lanes', ts: now, source: 'conductor',
      items: ready.map((l) => ({ text: `merge ${l.id}`, irreversible: true })),
    }];
  }
  if (/^(raise|set) daily cap to \$?(\d+)/i.test(t)) {
    const m = /\$?(\d+)/.exec(t);
    const value = m ? Number(m[1]) : db.caps.dailyUsd;
    if (value > db.caps.hardUsd) {
      return [{ k: `c-${now}`, type: 'refusal', text: `refused: $${value} is above the org hard limit $${db.caps.hardUsd} (FD-7)`, ts: now, source: 'conductor' }];
    }
    db.caps = { ...db.caps, dailyUsd: value };
    const jid = journal('caps.set', `daily cap set to $${value}`, null, true);
    return [{ k: `r-${now}`, type: 'receipt', text: `daily cap set to $${value}`, ts: now, source: 'conductor', jid, undoable: true }];
  }
  if (/^cap\b/i.test(t) && laneRef) {
    const m = /\$?(\d+)/.exec(t);
    const value = m ? Number(m[1]) : 0;
    if (value > db.caps.hardUsd) {
      return [{ k: `c-${now}`, type: 'refusal', text: `refused: $${value} is above the org hard limit $${db.caps.hardUsd} (FD-7)`, ts: now, source: 'conductor' }];
    }
    const lane = findLane(laneRef);
    if (lane) lane.capUsd = value;
    const jid = journal('run.cap.set', `${laneRef} cap set to $${value}`, laneRef, true);
    return [{ k: `r-${now}`, type: 'receipt', text: `${laneRef} cap set to $${value}`, ts: now, source: 'conductor', jid, undoable: true }];
  }
  if (/^answer\b/i.test(t)) {
    const rest = t.replace(/^answer\s*/i, '');
    const parked = db.lanes.find((l) => l.state === 'parked' && l.question);
    if (!parked || !parked.question) return [{ k: `c-${now}`, type: 'reply', text: 'nothing is parked right now.', ts: now, source: 'conductor' }];
    const answerText = rest.replace(new RegExp(`^${parked.question.key}\\s*`), '').trim() || rest.trim();
    parked.state = 'running';
    parked.heart = true;
    parked.question = null;
    const jid = journal('ask.answered', `${parked.id} answered: ${answerText}`, parked.id, false);
    appendEvent(`${parked.id} resumed`, parked.id);
    return [{ k: `r-${now}`, type: 'receipt', text: `${parked.id} resumed: ${answerText}`, ts: now, source: 'conductor', jid, undoable: false }];
  }
  if (/what's stuck|whats stuck/i.test(t)) {
    const stuck = db.lanes.filter((l) => l.state === 'blocked' || l.state === 'parked');
    return [{ k: `c-${now}`, type: 'reply', text: stuck.length ? stuck.map((l) => l.id).join(', ') : 'nothing is stuck.', ts: now, source: 'conductor' }];
  }
  if (/^why is/i.test(t) && laneRef) {
    const lane = findLane(laneRef);
    return [{ k: `c-${now}`, type: 'reply', text: lane?.reason ?? `${laneRef} has no recorded reason.`, ts: now, source: 'conductor' }];
  }
  if (/spend today/i.test(t)) {
    return [{ k: `c-${now}`, type: 'reply', text: `$${db.caps.spentTodayUsd.toFixed(2)} of a $${db.caps.dailyUsd} daily cap.`, ts: now, source: 'conductor' }];
  }
  if (/^status/i.test(t)) {
    const running = db.lanes.filter((l) => l.state === 'running').length;
    return [{ k: `c-${now}`, type: 'reply', text: `${running} running, ${db.lanes.length} lanes total.`, ts: now, source: 'conductor' }];
  }
  return [{ k: `c-${now}`, type: 'reply', text: "I understand pause, resume, kill <lane>, merge ready lanes, cap <lane> at $N, answer, what's stuck, spend today, status.", ts: now, source: 'conductor' }];
}

export function createStubServer() {
  const server = createServer((request, response) => {
    void (async () => {
      const urlPath = (request.url ?? '/').split('?')[0] ?? '/';
      const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '');
      const method = request.method ?? 'GET';

      if (urlPath === '/lanes' && method === 'GET') {
        const spentTodayUsd = db.lanes.reduce((sum, l) => sum + l.costUsd, 0);
        const burnUsdPerMin = db.lanes.reduce((sum, l) => sum + (l.state === 'running' ? l.burnUsdPerMin : 0), 0);
        json(response, 200, { at: Date.now(), lanes: db.lanes, spentTodayUsd, burnUsdPerMin });
        return;
      }
      if (urlPath === '/thread' && method === 'GET') {
        json(response, 200, { messages: db.thread });
        return;
      }
      if (urlPath === '/journal' && method === 'GET') {
        const since = query.has('since') ? Number(query.get('since')) : undefined;
        const run = query.get('run') ?? undefined;
        const limit = query.has('limit') ? Number(query.get('limit')) : undefined;
        let rows = db.journal;
        if (since !== undefined) rows = rows.filter((r) => r.ts >= since);
        if (run !== undefined) rows = rows.filter((r) => r.run === run);
        const total = rows.length;
        if (limit !== undefined) rows = rows.slice(0, limit);
        json(response, 200, { rows, total });
        return;
      }
      if (urlPath === '/integrations' && method === 'GET') {
        json(response, 200, { items: db.integrations, checkedAt: Date.now(), everyS: 30 });
        return;
      }
      if (urlPath === '/caps' && method === 'GET') {
        json(response, 200, db.caps);
        return;
      }
      if (urlPath === '/proposals' && method === 'GET') {
        const mergedToday = db.lanes.filter((l) => l.state === 'merged').length;
        const metrics = { mergedToday, humanWaitMin: 8, costPerMergeUsd: mergedToday > 0 ? db.caps.spentTodayUsd / mergedToday : null, wastedUsd: 12.4 };
        json(response, 200, { rules: db.rules, metrics, computedAt: Date.now() });
        return;
      }
      if (urlPath === '/queue' && method === 'GET') {
        json(response, 200, { items: db.queue, paused: db.queuePaused, maxInFlight: 2 });
        return;
      }

      const runThreadMatch = /^\/run\/([^/]+)\/thread$/.exec(urlPath);
      if (runThreadMatch && method === 'GET') {
        const id = decodeURIComponent(runThreadMatch[1] as string);
        json(response, 200, { messages: db.thread.filter((m) => m.lane === id) });
        return;
      }
      const runPrMatch = /^\/run\/([^/]+)\/pr$/.exec(urlPath);
      if (runPrMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runPrMatch[1] as string));
        json(response, 200, { pr: lane?.pr ?? null });
        return;
      }
      const runSandboxMatch = /^\/run\/([^/]+)\/sandbox$/.exec(urlPath);
      if (runSandboxMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runSandboxMatch[1] as string));
        const log = lane?.sandbox
          ? [
            { text: `${new Date().toISOString()} sandbox ready`, severity: 'info' as const },
            { text: `${new Date().toISOString()} ${lane.stepText}`, severity: 'progress' as const },
            ...(lane.fails > 0 ? [{ text: `${new Date().toISOString()} retrying after a failed build`, severity: 'retry' as const }] : []),
            ...(lane.runaway ? [{ text: `${new Date().toISOString()} build failed: exit 1`, severity: 'error' as const }] : []),
          ]
          : [];
        json(response, 200, { sandbox: lane?.sandbox ?? null, log });
        return;
      }
      const runCostMatch = /^\/run\/([^/]+)\/cost$/.exec(urlPath);
      if (runCostMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runCostMatch[1] as string));
        json(response, 200, {
          steps: lane ? stubCostSteps(lane) : [],
          capEnforcementFailedJid: lane?.runaway ? 'J-40211' : null,
        });
        return;
      }
      const runJournalMatch = /^\/run\/([^/]+)\/journal$/.exec(urlPath);
      if (runJournalMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runJournalMatch[1] as string));
        json(response, 200, { entries: lane ? stubJournalNarrative(lane) : [] });
        return;
      }

      const runKillMatch = /^\/run\/([^/]+)\/kill$/.exec(urlPath);
      if (runKillMatch && method === 'POST') {
        const id = decodeURIComponent(runKillMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'killed'; lane.heart = false; lane.burnUsdPerMin = 0; lane.hopStatus = 'blocked';
        const jid = journal('run.killed', `${id} killed`, id, false);
        appendEvent(`${id} killed`, id);
        publish({ type: 'run.killed', run: id });
        json(response, 200, ok(jid, `${id} killed`, false, lane));
        return;
      }
      const runPauseMatch = /^\/run\/([^/]+)\/pause$/.exec(urlPath);
      if (runPauseMatch && method === 'POST') {
        const id = decodeURIComponent(runPauseMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'paused'; lane.heart = false;
        const jid = journal('run.paused', `${id} paused`, id, true);
        json(response, 200, ok(jid, `${id} paused`, true, lane));
        return;
      }
      const runResumeMatch = /^\/run\/([^/]+)\/resume$/.exec(urlPath);
      if (runResumeMatch && method === 'POST') {
        const id = decodeURIComponent(runResumeMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'running'; lane.heart = true; lane.verifiedAt = Date.now();
        const jid = journal('run.resumed', `${id} resumed`, id, false);
        json(response, 200, ok(jid, `${id} resumed`, false, lane));
        return;
      }
      const runMergeMatch = /^\/run\/([^/]+)\/merge$/.exec(urlPath);
      if (runMergeMatch && method === 'POST') {
        const id = decodeURIComponent(runMergeMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'merged'; lane.hop = 5; lane.hopStatus = 'done';
        const jid = journal('chain.merged', `${id} merged`, id, false);
        appendEvent(`${id} merged`, id);
        publish({ type: 'chain.merged', run: id });
        json(response, 200, ok(jid, `${id} merged`, false, lane));
        return;
      }
      const runReopenMatch = /^\/run\/([^/]+)\/reopen$/.exec(urlPath);
      if (runReopenMatch && method === 'POST') {
        const id = decodeURIComponent(runReopenMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'running'; lane.attempt += 1; lane.fails = 0; lane.runaway = false; lane.heart = true;
        const jid = journal('run.reopened', `${id} reopened (attempt ${lane.attempt})`, id, false);
        json(response, 200, ok(jid, `${id} reopened`, false, lane));
        return;
      }
      const runCompactMatch = /^\/run\/([^/]+)\/compact$/.exec(urlPath);
      if (runCompactMatch && method === 'POST') {
        const id = decodeURIComponent(runCompactMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.ctxTokens = Math.round(lane.ctxCeiling * 0.45); lane.state = 'running'; lane.heart = true;
        const jid = journal('run.compacted', `${id} compacted and resumed`, id, false);
        json(response, 200, ok(jid, `${id} compacted and resumed`, false, lane));
        return;
      }
      const runVerifyMatch = /^\/run\/([^/]+)\/verify$/.exec(urlPath);
      if (runVerifyMatch && method === 'POST') {
        const id = decodeURIComponent(runVerifyMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'done';
        if (!lane.pr) lane.pr = { no: 900 + db.jn, url: 'https://example.invalid/pr/verify', files: 1, add: 1, del: 0, draft: true };
        const jid = journal('run.verified', `${id} verified`, id, false);
        json(response, 200, ok(jid, `${id} verified`, false, lane));
        return;
      }
      const runCapMatch = /^\/run\/([^/]+)\/cap$/.exec(urlPath);
      if (runCapMatch && method === 'POST') {
        const id = decodeURIComponent(runCapMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        const body = await readJson<{ capUsd?: number }>(request);
        const capUsd = body.capUsd ?? 0;
        if (capUsd > db.caps.hardUsd) { json(response, 422, { error: `above the org hard limit`, hardUsd: db.caps.hardUsd }); return; }
        const previous = lane.capUsd;
        lane.capUsd = capUsd;
        const jid = journal('run.cap.set', `${id} cap set to $${capUsd}`, id, true);
        db.journal[0]!.text += ` (was ${previous === null ? 'unset' : `$${previous}`})`;
        json(response, 200, ok(jid, `${id} cap set to $${capUsd}`, true, lane));
        return;
      }

      if (urlPath === '/caps' && method === 'POST') {
        const body = await readJson<{ dailyUsd?: number; runUsd?: number }>(request);
        if ((body.dailyUsd !== undefined && body.dailyUsd > db.caps.hardUsd) || (body.runUsd !== undefined && body.runUsd > db.caps.hardUsd)) {
          json(response, 422, { error: 'above the org hard limit', hardUsd: db.caps.hardUsd });
          return;
        }
        db.caps = { ...db.caps, dailyUsd: body.dailyUsd ?? db.caps.dailyUsd, runUsd: body.runUsd ?? db.caps.runUsd };
        journal('caps.set', `caps updated: daily $${db.caps.dailyUsd}, per-run $${db.caps.runUsd}`, null, true);
        json(response, 200, db.caps);
        return;
      }

      if (urlPath === '/command' && method === 'POST') {
        const body = await readJson<{ text?: string }>(request);
        const cards = runCommand(body.text ?? '');
        db.thread = [...db.thread, ...cards];
        json(response, 200, { cards });
        return;
      }

      if (urlPath === '/queue' && method === 'POST') {
        const body = await readJson<QueueAddRequest>(request);
        json(response, 200, addQueueItem(body));
        return;
      }
      if (urlPath === '/queue/pause' && method === 'POST') {
        db.queuePaused = true;
        json(response, 200, { ok: true, jid: null, message: 'queue paused', undoable: true });
        return;
      }
      if (urlPath === '/queue/resume' && method === 'POST') {
        db.queuePaused = false;
        json(response, 200, { ok: true, jid: null, message: 'queue resumed', undoable: false });
        return;
      }
      const queueItemMatch = /^\/queue\/([^/]+)\/(remove|retry)$/.exec(urlPath);
      if (queueItemMatch && method === 'POST') {
        const id = decodeURIComponent(queueItemMatch[1] as string);
        const action = queueItemMatch[2];
        const item = db.queue.find((q) => q.id === id);
        if (action === 'remove') {
          if (!item) { json(response, 404, { ok: false, jid: null, message: `no queue item ${id}`, undoable: false }); return; }
          db.queue = db.queue.filter((q) => q.id !== id);
          json(response, 200, { ok: true, jid: null, message: `removed ${id}`, undoable: false });
          return;
        }
        if (!item || (item.state !== 'parked' && item.state !== 'failed')) {
          json(response, 409, { ok: false, jid: null, message: `${id} is not parked or failed`, undoable: false });
          return;
        }
        item.state = 'queued';
        item.reason = null;
        item.updatedAt = Date.now();
        json(response, 200, { ok: true, jid: null, message: `${id} is queued again`, undoable: false });
        return;
      }

      // `POST /send`: the real server's own run-scoped delivery (`ForgeServer.send`,
      // `RunInbox.send`) -- a card lands on that one run's own thread, tagged with its
      // `lane`, never routed through the free-text command classifier `/command` uses.
      if (urlPath === '/send' && method === 'POST') {
        const body = await readJson<{ run?: string; text?: string }>(request);
        if (!body.run || !body.text) {
          json(response, 400, { error: 'a send needs a run and text' });
          return;
        }
        const now = Date.now();
        db.thread = [...db.thread, {
          k: `send-${now}-${Math.random()}`, type: 'operator', text: body.text, ts: now,
          source: 'operator', lane: body.run,
        }];
        json(response, 200, { ok: true });
        return;
      }

      const checkMatch = /^\/integrations\/([^/]+)\/check$/.exec(urlPath);
      if (checkMatch && method === 'POST') {
        const id = decodeURIComponent(checkMatch[1] as string);
        db.integrations = db.integrations.map((i) => (i.id === id ? { ...i, checkedAt: Date.now() } : i));
        json(response, 200, { items: db.integrations, checkedAt: Date.now(), everyS: 30 });
        return;
      }
      const reconnectMatch = /^\/integrations\/([^/]+)\/reconnect$/.exec(urlPath);
      if (reconnectMatch && method === 'POST') {
        const id = decodeURIComponent(reconnectMatch[1] as string);
        const integration = db.integrations.find((i) => i.id === id);
        if (!integration) { json(response, 404, { error: `no integration named ${id}` }); return; }
        integration.status = 'ok'; integration.since = null; integration.step = 3;
        for (const lane of db.lanes) {
          if (lane.blockedBy === id) { lane.state = 'running'; lane.heart = true; lane.blockedBy = null; }
        }
        const jid = journal('blocker.cleared', `${integration.name} reconnected`, null, false);
        appendEvent(`${integration.name} reconnected`);
        publish({ type: 'blocker.cleared', integration: id });
        json(response, 200, {
          ok: true, integration, steps: [{ text: 'open SSO', done: true }, { text: 'verify', done: true }, { text: 'resume lanes', done: true }],
          message: `${integration.name} reconnected`, jid,
        });
        return;
      }

      const applyMatch = /^\/proposals\/([^/]+)\/apply$/.exec(urlPath);
      if (applyMatch && method === 'POST') {
        const id = decodeURIComponent(applyMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        const jid = journal('decision.made', `applied ${rule.title}`, null, true);
        rule.status = 'applied'; rule.jid = jid;
        if (id === 'kill3') {
          const target = db.lanes.find((l) => l.fails >= 2);
          if (target) { target.state = 'killed'; target.heart = false; appendEvent(`${target.id} killed by rule ${rule.title}`, target.id); }
        }
        if (id === 'autoans') {
          const parked = db.lanes.find((l) => l.state === 'parked' && l.question);
          if (parked && parked.question) {
            parked.state = 'running'; parked.heart = true; parked.question = null;
            appendEvent(`${parked.id} auto-answered by rule ${rule.title}`, parked.id);
          }
        }
        json(response, 200, ok(jid, `applied ${rule.title}`, true, undefined));
        return;
      }
      const dismissMatch = /^\/proposals\/([^/]+)\/dismiss$/.exec(urlPath);
      if (dismissMatch && method === 'POST') {
        const id = decodeURIComponent(dismissMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        rule.status = 'dismissed';
        const jid = journal('decision.made', `dismissed ${rule.title}`, null, true);
        json(response, 200, ok(jid, `dismissed ${rule.title}`, true));
        return;
      }
      const restoreMatch = /^\/proposals\/([^/]+)\/restore$/.exec(urlPath);
      if (restoreMatch && method === 'POST') {
        const id = decodeURIComponent(restoreMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        rule.status = 'open';
        json(response, 200, ok('', `restored ${rule.title}`, false));
        return;
      }

      const undoMatch = /^\/journal\/([^/]+)\/undo$/.exec(urlPath);
      if (undoMatch && method === 'POST') {
        const jid = decodeURIComponent(undoMatch[1] as string);
        const entry = db.journal.find((j) => j.jid === jid);
        if (!entry || !entry.undoable || entry.undone) { json(response, 409, { error: `${jid} cannot be undone` }); return; }
        entry.undone = true;
        if (entry.kind === 'run.paused' && entry.run) {
          const lane = findLane(entry.run);
          if (lane) { lane.state = 'running'; lane.heart = true; }
        }
        json(response, 200, ok(jid, `undone ${jid}`, false));
        return;
      }

      serveStatic(request, response, urlPath);
    })();
  });

  server.on('upgrade', (request, socket) => {
    const duplex = socket as Duplex;
    const urlPath = (request.url ?? '/').split('?')[0];
    const key = request.headers['sec-websocket-key'];
    if (urlPath !== '/events' || typeof key !== 'string') {
      duplex.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    duplex.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
      + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(duplex);
    duplex.on('close', () => sockets.delete(duplex));
    // A page navigation or a Playwright route abort tears this socket down without a
    // clean close; with no listener here Node treats that as an unhandled 'error' and
    // takes the whole stub server down mid-suite (ECONNABORTED, seen 2026-09-05 killing
    // every test after the first WS client left).
    duplex.on('error', () => sockets.delete(duplex));
  });

  const heartbeat = setInterval(() => publish({ type: 'heartbeat', at: Date.now() }), HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));

  return server;
}

/** Test-only: put the fixtures back to their seed shape between specs. */
export function resetStubDb(): void {
  db = seedDb();
}

function isMainModule(): boolean {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  const server = createStubServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`forge console stub: http://127.0.0.1:${PORT} (token ${TOKEN})`);
  });
}
