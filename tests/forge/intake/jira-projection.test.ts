/**
 * Requirement 2 (packets), requirement 4 (Jira projection in Aaron's voice) and the
 * Sentry-to-ticket idempotency specimen from the brief's acceptance list: running the
 * poller twice against one fixed Sentry issue fixture creates exactly one BBZ ticket,
 * keyed by the Sentry short id.
 *
 * The sink here is a fake, in-memory Jira: no live call anywhere in this file.
 */
import { describe, expect, it } from 'vitest';

import { createFakeJiraSink, ensureTicketForFinding, writeVoicedComment } from '../../../src/forge/intake/jiraProjection.js';
import type { Packet } from '../../../src/forge/contracts.js';

function packet(id: string): Packet {
  return {
    id, ticket: '', what: 'Login screen crashes on cold start with airplane mode on',
    where: 'src/features/auth/LoginScreen.tsx:41',
    evidence: ['Sentry SENTRY-9001: TypeError undefined is not a function'],
    confidence: 'high', repo: 'mobile-app', blockedBy: [], at: 1_725_000_000_000,
  };
}

describe('ensureTicketForFinding — Sentry-to-ticket idempotency', () => {
  it('creates exactly one ticket the first time', async () => {
    const jira = createFakeJiraSink();
    const created = await ensureTicketForFinding(jira, 'SENTRY-9001', packet('pkt-1'));
    expect(created.wasCreated).toBe(true);
    expect(jira.tickets.size).toBe(1);
  });

  it('running the poller a second time against the SAME fixed issue creates no second ticket', async () => {
    const jira = createFakeJiraSink();
    await ensureTicketForFinding(jira, 'SENTRY-9001', packet('pkt-1'));
    const second = await ensureTicketForFinding(jira, 'SENTRY-9001', packet('pkt-1'));
    expect(second.wasCreated).toBe(false);
    expect(jira.tickets.size).toBe(1);
  });

  it('falsifier check: a single-pass specimen alone would pass without idempotency — this file runs it twice', async () => {
    const jira = createFakeJiraSink();
    const first = await ensureTicketForFinding(jira, 'SENTRY-9001', packet('pkt-1'));
    const second = await ensureTicketForFinding(jira, 'SENTRY-9001', packet('pkt-1'));
    expect(first.ticketKey).toBe(second.ticketKey);
  });
});

describe('writeVoicedComment — the guard runs before the sink, never after', () => {
  it('refuses a comment carrying third-person Aaron phrasing before it ever reaches the sink', async () => {
    const jira = createFakeJiraSink();
    const result = await writeVoicedComment(
      jira, 'BBZ-1', 'Aaron reported that this fails on cold start.', 'op-1',
    );
    expect(result.ok).toBe(false);
    expect(jira.comments.get('BBZ-1') ?? []).toHaveLength(0);
  });

  it('writes a clean comment with the hidden operation marker embedded', async () => {
    const jira = createFakeJiraSink();
    const result = await writeVoicedComment(
      jira, 'BBZ-1', 'Filed under BBZ-1; crash traced to a missing null check.', 'op-2',
    );
    expect(result.ok).toBe(true);
    const comments = jira.comments.get('BBZ-1') ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('forge-intake-op:op-2');
  });
});
