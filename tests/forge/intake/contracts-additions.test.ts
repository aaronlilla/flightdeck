/**
 * Requirement 1/7/8's data-contract half: `PollSource`, `Watermark` and `PacketSchema`
 * are new exports on the shared `contracts.ts` file (Intake decision 4 — additive only,
 * never a change to an existing shape).
 *
 * Watched red first: before this stream added the three exports, this file failed to
 * import them at all (`SyntaxError`/`undefined` from `contracts.ts`, not a normal
 * assertion failure) — pasted into the brief's dated Status section.
 */
import { describe, expect, it } from 'vitest';

import {
  PacketSchema,
  PollSourceSchema,
  WatermarkSchema,
  type Packet,
  type PollSource,
  type Watermark,
} from '../../../src/forge/contracts.js';

describe('PollSource', () => {
  it('names a source, a per-source id shape, and the updated/watermark field', () => {
    const source: PollSource = {
      name: 'jira',
      id: 'BBZ-142',
      updated: 1_725_000_000_000,
    };
    expect(PollSourceSchema.parse(source)).toEqual(source);
  });

  it('rejects a source name outside the closed union', () => {
    const bad = { name: 'carrier-pigeon', id: 'x', updated: 1 };
    expect(PollSourceSchema.safeParse(bad).success).toBe(false);
  });
});

describe('Watermark', () => {
  it('carries the source, the last-committed updated value, and the ids seen at that value', () => {
    const mark: Watermark = {
      source: 'jira',
      committedAt: 1_725_000_000_000,
      idsAtCommittedAt: ['BBZ-140', 'BBZ-141'],
    };
    expect(WatermarkSchema.parse(mark)).toEqual(mark);
  });
});

describe('PacketSchema', () => {
  it('carries what/where/evidence/confidence/repo/blocked-by, per the spine spec', () => {
    const packet: Packet = {
      id: 'pkt-1',
      ticket: 'BBZ-142',
      what: 'Login screen throws on cold start',
      where: 'src/features/auth/LoginScreen.tsx:41',
      evidence: ['Sentry issue BBZ-1: TypeError undefined is not a function'],
      confidence: 'high',
      repo: 'mobile-app',
      blockedBy: [],
      at: 1_725_000_000_000,
    };
    expect(PacketSchema.parse(packet)).toEqual(packet);
  });

  it('rejects a confidence value outside low/medium/high', () => {
    const bad = {
      id: 'pkt-2', ticket: 'BBZ-1', what: 'x', where: 'x', evidence: [], confidence: 'maybe',
      repo: 'x', blockedBy: [], at: 1,
    };
    expect(PacketSchema.safeParse(bad).success).toBe(false);
  });
});
