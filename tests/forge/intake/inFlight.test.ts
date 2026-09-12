/**
 * Item 2 of the ticket-friction goal: a ticket with shipped work still reads Backlog.
 *
 * The specimen is the real one. A ticket read `Backlog`, `assignee: null` on the board
 * while carrying a draft pull request opened that morning, visible only in its comments.
 * Picking by status alone would have duplicated finished work.
 *
 * Every assertion below therefore reads comments and remote links, never the status
 * field, and the edge cases are the three ways a mention can be stale: a closed pull
 * request (abandoned -- start), a merged one (landed -- refuse), and a key mentioned on
 * somebody else's ticket (never reaches this ticket's check at all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetReadabilityContractForTests } from '../../../src/forge/intake/readability.ts';
import {
  checkTicketInFlight,
  findPullRequestRefs,
  type PullRequestState,
} from '../../../src/forge/intake/inFlight.ts';
import { ticketKeysIn, runPrOpenedHandoff } from '../../../src/forge/intake/prOpened.ts';
import type { JiraWriteClient } from '../../../src/forge/intake/jira.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEUTRAL_SPECIMENS_SRC = path.join(__dirname, '..', 'specimens', 'readability');

const PR_URL = 'https://github.com/acme/acme-app/pull/161';
const OTHER_PR_URL = 'https://github.com/acme/acme-app/pull/284';

let contractDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env['FORGE_READABILITY_DIR'];
  contractDir = mkdtempSync(path.join(tmpdir(), 'forge-inflight-'));
  cpSync(NEUTRAL_SPECIMENS_SRC, contractDir, { recursive: true });
  process.env['FORGE_READABILITY_DIR'] = contractDir;
  resetReadabilityContractForTests();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env['FORGE_READABILITY_DIR'];
  else process.env['FORGE_READABILITY_DIR'] = originalEnv;
  resetReadabilityContractForTests();
  rmSync(contractDir, { recursive: true, force: true });
});

/** A fake whose comments and remote links belong to ONE ticket key, so a test can prove
 *  that another ticket's comments are never consulted. */
function depsFor(byTicket: Record<string, { comments?: string[]; links?: string[] }>, states: Record<number, PullRequestState>) {
  const asked: string[] = [];
  const statesRead: number[] = [];
  return {
    asked,
    statesRead,
    deps: {
      comments: async (ticket: string) => {
        asked.push(ticket);
        return byTicket[ticket]?.comments ?? [];
      },
      remoteLinks: async (ticket: string) => byTicket[ticket]?.links ?? [],
      stateOf: async (_repo: string, pr: number) => {
        statesRead.push(pr);
        const state = states[pr];
        if (!state) throw new Error(`no such pull request ${pr}`);
        return state;
      },
    },
  };
}

describe('findPullRequestRefs', () => {
  it('finds a pull request URL in prose and deduplicates the same one quoted twice', () => {
    const refs = findPullRequestRefs([
      { where: 'comment', text: `Opened ${PR_URL} this morning, still a draft.` },
      { where: 'comment', text: `see ${PR_URL}` },
      { where: 'remote-link', text: OTHER_PR_URL },
    ]);
    expect(refs.map((r) => r.pr)).toEqual([161, 284]);
    expect(refs[0]).toMatchObject({ repo: 'acme/acme-app', pr: 161, url: PR_URL, where: 'comment' });
    expect(refs[1]!.where).toBe('remote-link');
  });

  it('finds nothing in a comment that mentions no pull request', () => {
    expect(findPullRequestRefs([{ where: 'comment', text: 'Reproduced on a phone, 23px exposed.' }])).toEqual([]);
  });
});

describe('checkTicketInFlight -- never reads the status field', () => {
  it('refuses a ticket whose comment names an OPEN pull request, quoting the URL', async () => {
    const { deps } = depsFor({ 'ACME-284': { comments: [`Opened ${PR_URL} this morning.`] } }, { 161: 'OPEN' });
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(false);
    expect(verdict.reason).toContain(PR_URL);
    expect(verdict.reason).toContain('open pull request');
    expect(verdict.pr?.pr).toBe(161);
  });

  it('starts a ticket with no pull request mentioned anywhere', async () => {
    const { deps } = depsFor({ 'ACME-284': { comments: ['Reproduced on a phone.'] } }, {});
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(true);
  });

  it('finds the pull request in a remote link when no comment mentions it', async () => {
    const { deps } = depsFor({ 'ACME-284': { links: [PR_URL] } }, { 161: 'OPEN' });
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(false);
    expect(verdict.pr?.where).toBe('remote-link');
  });

  // Edge case 1: a comment naming a CLOSED pull request. The work was abandoned without
  // landing, so the ticket is genuinely free -- refusing here would strand it forever.
  it('starts a ticket whose only pull request was closed without merging, and says so', async () => {
    const { deps } = depsFor({ 'ACME-284': { comments: [`gave up on ${PR_URL}`] } }, { 161: 'CLOSED' });
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(true);
    expect(verdict.reason).toContain('closed');
    expect(verdict.reason).toContain(PR_URL);
  });

  // Edge case 2: a comment naming a MERGED pull request. The work landed; the status
  // field is simply out of date, which is the whole defect.
  it('refuses a ticket whose pull request already merged', async () => {
    const { deps } = depsFor({ 'ACME-284': { comments: [PR_URL] } }, { 161: 'MERGED' });
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(false);
    expect(verdict.reason).toContain('merged');
    expect(verdict.reason).toContain(PR_URL);
  });

  // Edge case 3: the key appears in a comment on a DIFFERENT ticket. Only the named
  // ticket's own comments are read, so it never reaches this decision.
  it('ignores a pull request mentioned on another ticket entirely', async () => {
    const { deps, asked } = depsFor(
      {
        'ACME-284': { comments: ['Reproduced on a phone.'] },
        'ACME-999': { comments: [`ACME-284 is covered by ${PR_URL}`] },
      },
      { 161: 'OPEN' },
    );
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(true);
    expect(asked).toEqual(['ACME-284']);
  });

  // Standing order 1: an unmeasured pull request reads as in flight, never as absent.
  it('refuses when the pull request state cannot be read at all', async () => {
    const { deps } = depsFor({ 'ACME-284': { comments: [PR_URL] } }, {});
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(false);
    expect(verdict.reason).toContain('could not be read');
    expect(verdict.reason).toContain(PR_URL);
  });

  it('refuses on the first open pull request without reading the rest', async () => {
    const { deps, statesRead } = depsFor(
      { 'ACME-284': { comments: [`${PR_URL} and ${OTHER_PR_URL}`] } },
      { 161: 'OPEN', 284: 'OPEN' },
    );
    const verdict = await checkTicketInFlight('ACME-284', deps);
    expect(verdict.start).toBe(false);
    expect(statesRead).toEqual([161]);
  });
});

describe('ticketKeysIn -- the key pattern comes from the contract', () => {
  it('takes every distinct key out of a pull request title and body', () => {
    expect(ticketKeysIn('ACME-284 Stop the sheet dismissing itself\n\nAlso closes ACME-285 and ACME-284.'))
      .toEqual(['ACME-284', 'ACME-285']);
  });

  it('finds nothing when the text names no key', () => {
    expect(ticketKeysIn('Tab bar clearance on four more screens')).toEqual([]);
  });
});

describe('runPrOpenedHandoff -- the ticket moves when the pull request opens', () => {
  function writeClient() {
    const calls: string[] = [];
    const client: JiraWriteClient = {
      async comment(key) { calls.push(`comment:${key}`); return { ok: true, status: 201 }; },
      async assign(key, accountId) { calls.push(`assign:${key}:${accountId}`); return { ok: true, status: 204 }; },
      async transition(key, id) { calls.push(`transition:${key}:${id}`); return { ok: true, status: 204 }; },
      async link(key, url) { calls.push(`link:${key}:${url}`); return { ok: true, status: 201 }; },
    };
    return { client, calls };
  }

  it('assigns, transitions and links the ticket the pull request names', async () => {
    const { client, calls } = writeClient();
    const events: string[] = [];
    await runPrOpenedHandoff(
      client,
      { prUrl: PR_URL, title: 'ACME-284 Stop the sheet dismissing itself', body: 'What breaks...' },
      { wipAccountId: 'acct-1', wipTransitionId: '21' },
      (event) => events.push(event.event),
    );
    expect(calls).toEqual(['assign:ACME-284:acct-1', 'transition:ACME-284:21', `link:ACME-284:${PR_URL}`]);
    expect(events).toContain('pr-opened.assigned');
    expect(events).toContain('pr-opened.transitioned');
  });

  it('changes nothing and says so when the pull request names no ticket key', async () => {
    const { client, calls } = writeClient();
    const events: string[] = [];
    const lines = await runPrOpenedHandoff(
      client,
      { prUrl: PR_URL, title: 'Tab bar clearance on four more screens', body: '' },
      { wipAccountId: 'acct-1', wipTransitionId: '21' },
      (event) => events.push(event.event),
    );
    expect(calls).toEqual([]);
    expect(events).toEqual(['pr-opened.no-key']);
    expect(lines.join(' ')).toContain('names no ticket key');
  });

  it('reports a failed write rather than throwing, and still attempts the next one', async () => {
    const calls: string[] = [];
    const client: JiraWriteClient = {
      async comment() { return { ok: true }; },
      async assign(key) { calls.push(`assign:${key}`); return { ok: false, status: 403, body: 'no permission' }; },
      async transition(key) { calls.push(`transition:${key}`); return { ok: true, status: 204 }; },
      async link(key) { calls.push(`link:${key}`); return { ok: true, status: 201 }; },
    };
    const events: string[] = [];
    const lines = await runPrOpenedHandoff(
      client,
      { prUrl: PR_URL, title: 'ACME-284 Fix it', body: '' },
      { wipAccountId: 'acct-1', wipTransitionId: '21' },
      (event) => events.push(event.event),
    );
    expect(calls).toEqual(['assign:ACME-284', 'transition:ACME-284', 'link:ACME-284']);
    expect(events).toContain('pr-opened.failed');
    expect(lines.join(' ')).toContain('403');
  });
});
