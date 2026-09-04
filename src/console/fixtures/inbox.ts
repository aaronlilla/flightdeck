/**
 * Fixture `/inbox` shape, copied from `inbox.ts#InboxEntry` on main.
 */
import type { InboxEntry, InboxState } from '../types.js';

const now = Date.parse('2026-09-04T18:00:00Z');

export const openQuestion: InboxEntry = {
  key: 'a1b2c3d4e5f60718',
  question: 'dev tenant or the production Auth0 tenant for this run?',
  options: ['dev', 'production'],
  kind: 'question',
  runs: ['withdrawal-fee'],
  asked: 1,
  at: now - 8 * 60_000,
  disposition: 'park',
  ticket: 'BBZ-412',
};

export const answeredQuestion: InboxEntry = {
  key: 'f00dbeef1122aabb',
  question: 'skip the flaky snapshot test or fix it first?',
  options: ['skip it', 'fix it first'],
  kind: 'question',
  runs: ['tour-and-onboarding'],
  asked: 1,
  at: now - 2 * 3_600_000,
  answer: 'fix it first',
  answeredAt: now - 3_500_000,
  disposition: 'park',
};

export const inboxFixture: InboxState = {
  open: [openQuestion],
  all: [answeredQuestion, openQuestion],
};

export const emptyInboxFixture: InboxState = { open: [], all: [] };
