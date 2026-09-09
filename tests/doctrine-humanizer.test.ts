/**
 * The humanizer skill in doctrine/ is a copy of the one dev-harness installs, and a
 * copy drifts. The doctrine copy sat at a 534-line fork missing two sections for a
 * fortnight before anyone noticed, because nothing compared them. This test does,
 * whenever the dev-harness checkout is on the machine, and skips where it is not so
 * CI on another box does not fail on a file it cannot see.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repoRoot = path.resolve(here, '..');
const doctrineSkill = path.join(repoRoot, 'doctrine', 'skills', 'humanizer', 'SKILL.md');
// The installed copy is what every session and worker actually loads, and install.ps1
// writes it from dev-harness master, so it is the operative source to match. The main
// dev-harness checkout can sit on any branch and would make this flap. DEV_HARNESS_ROOT
// points the comparison at a checkout instead, for a pull request not yet installed.
const sourceSkill = process.env['DEV_HARNESS_ROOT']
  ? path.join(process.env['DEV_HARNESS_ROOT'], 'skills', 'humanizer', 'SKILL.md')
  : path.join(os.homedir(), '.claude', 'skills', 'humanizer', 'SKILL.md');

/** Read a file as LF text: the Windows checkout is CRLF, a Linux CI checkout is LF. */
function readLf(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---\n')) throw new Error('no frontmatter');
  const body = text.slice(4, text.indexOf('\n---\n', 4));
  const keys: Record<string, string> = {};
  for (const line of body.split('\n')) {
    if (!line || line.startsWith(' ') || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    keys[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^"|"$/g, '');
  }
  return keys;
}

describe('doctrine humanizer skill', () => {
  const doctrine = readLf(doctrineSkill);

  it('runs as a Haiku fork that waits for its result', () => {
    const keys = frontmatter(doctrine);
    expect(keys['context']).toBe('fork');
    expect(keys['model']).toBe('haiku');
    expect(keys['background']).toBe('false');
  });

  it('is scoped to audiences other than Aaron and Claude', () => {
    const description = frontmatter(doctrine)['description'] ?? '';
    for (const repo of ['v2-React-Native', 'BBManagementSystemV2', 'bb-infra', 'boltbetz-docs']) {
      expect(description).toContain(repo);
    }
    expect(description).toContain('flightdeck');
    expect(doctrine).toContain('### I. Scope: who reads it');
  });

  it.skipIf(!existsSync(sourceSkill))('matches the installed dev-harness copy byte for byte', () => {
    expect(doctrine).toBe(readLf(sourceSkill));
  });
});
