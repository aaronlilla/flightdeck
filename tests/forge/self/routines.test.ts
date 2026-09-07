import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendRoutinesSection, loadRoutines, matchRoutines, type Routine } from '../../../src/forge/self/routines.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-self-routines-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRoutine(name: string, tags: string[], body: string): void {
  writeFileSync(
    join(dir, name),
    `---\ntags: [${tags.join(', ')}]\n---\n${body}\n`,
    'utf8',
  );
}

describe('loadRoutines', () => {
  it('reads front-matter tags and the body under them', () => {
    writeRoutine('one.md', ['frontend', 'lint'], '# Do the thing\n\nSteps here.');
    const routines = loadRoutines(dir);
    expect(routines).toHaveLength(1);
    expect(routines[0]!.tags).toEqual(['frontend', 'lint']);
    expect(routines[0]!.body).toContain('Do the thing');
    expect(routines[0]!.slug).toBe('one');
  });

  it('ignores a non-markdown file', () => {
    writeFileSync(join(dir, 'notes.txt'), 'not a routine', 'utf8');
    expect(loadRoutines(dir)).toHaveLength(0);
  });

  it('returns an empty list for a directory that does not exist', () => {
    expect(loadRoutines(join(dir, 'missing'))).toHaveLength(0);
  });
});

describe('matchRoutines', () => {
  const routines: Routine[] = [
    { slug: 'fe-lint', tags: ['frontend', 'lint'], body: 'fe lint body', path: 'fe-lint.md' },
    { slug: 'backend-migration', tags: ['backend', 'migration'], body: 'backend body', path: 'backend-migration.md' },
    { slug: 'general', tags: ['general'], body: 'general body', path: 'general.md' },
  ];

  it('matches a routine whose tag equals the packet repoKind', () => {
    const found = matchRoutines({ repoKind: 'frontend', keywords: [] }, routines);
    expect(found.map((r) => r.slug)).toContain('fe-lint');
    expect(found.map((r) => r.slug)).not.toContain('backend-migration');
  });

  it('matches a routine whose tag equals a packet keyword', () => {
    const found = matchRoutines({ keywords: ['migration'] }, routines);
    expect(found.map((r) => r.slug)).toContain('backend-migration');
  });

  it('matches nothing when nothing in the packet overlaps any tag', () => {
    const found = matchRoutines({ repoKind: 'frontend', keywords: ['unrelated'] }, routines);
    expect(found.map((r) => r.slug)).not.toContain('backend-migration');
    expect(found.map((r) => r.slug)).not.toContain('general');
  });
});

describe('appendRoutinesSection', () => {
  it('leaves the brief unchanged when there are no matching routines', () => {
    expect(appendRoutinesSection('# Brief\n\ntext', [])).toBe('# Brief\n\ntext');
  });

  it('appends a Routines heading with every matched routine body', () => {
    const routines: Routine[] = [{ slug: 'r1', tags: ['a'], body: 'do the r1 thing', path: 'r1.md' }];
    const out = appendRoutinesSection('# Brief\n\ntext', routines);
    expect(out).toContain('## Routines');
    expect(out).toContain('do the r1 thing');
    expect(out.indexOf('# Brief')).toBeLessThan(out.indexOf('## Routines'));
  });
});
