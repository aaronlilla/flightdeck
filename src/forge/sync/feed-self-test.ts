/**
 * R-101: the Jira feed's self-test switch. While it is on, the feed answers the
 * operator's own comments, so the whole comment pipeline and its response time can be
 * tried with no second person. It is temporary by construction: the file holds an end
 * time rather than a flag, and a switch nobody turns off still turns itself off.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { jiraFeedSelfTestPath } from '../paths.js';

/** The longest a self-test can be switched on for in one go. */
export const SELF_TEST_MAX_MINUTES = 240;

/** When the self-test ends, or null when it is off (never set, turned off, or expired). */
export function readSelfTestUntil(path: string = jiraFeedSelfTestPath(), now: number = Date.now()): number | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { until?: unknown };
    return typeof data.until === 'number' && data.until > now ? data.until : null;
  } catch {
    return null;
  }
}

/** Turns the self-test on for `minutes` (clamped to the maximum), or off at 0. Returns
 *  the end time, or null when off. */
export function writeSelfTest(minutes: number, path: string = jiraFeedSelfTestPath(), now: number = Date.now()): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    if (existsSync(path)) rmSync(path);
    return null;
  }
  const until = now + Math.min(minutes, SELF_TEST_MAX_MINUTES) * 60_000;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ until }), 'utf8');
  return until;
}
