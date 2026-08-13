import { describe, expect, it } from 'vitest';

import { isExempt, scanText } from './agnostic.ts';
import { runInjections } from './fault-inject.ts';

const join = (...parts: string[]) => parts.join('');

describe('contamination detectors', () => {
  it('fires on every broken specimen and stays silent on every control', () => {
    const results = runInjections();
    const failures = results.filter((r) => !r.ok);
    expect(
      failures.map((f) => `${f.name}: expected ${f.expected}, got ${f.fired.join(',') || 'silence'}`),
    ).toEqual([]);
    expect(results.length).toBeGreaterThan(0);
  });

  it('reports the offending line number', () => {
    const text = ['clean line', 'clean line', `const x = "${join('holo', 'scene')}-engine";`].join('\n');
    const findings = scanText('example.ts', text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.rule).toBe('project-specific-name');
  });

  it('exempts only what the exemption list names', () => {
    expect(isExempt('package-lock.json')).toBe(true);
    expect(isExempt('src/kernel/router.ts')).toBe(false);
  });

  it('does not treat the checker source as an exemption', () => {
    // The patterns are built from fragments precisely so this file and the
    // detector itself can be scanned like anything else.
    expect(isExempt('tests/checks/agnostic.ts')).toBe(false);
    expect(isExempt('tests/checks/fault-inject.ts')).toBe(false);
  });
});
