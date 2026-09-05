/**
 * The protected-capability classifier, dormancy condition
 * (`2026-09-04-forge-spine-sdk-workers.md:972-973`): checks the proposed diff, not the
 * reported path, and never more permissive than `gotcha.ts`'s `AARON_ONLY` list.
 */
import { describe, expect, it } from 'vitest';

import { classifyGotcha, AARON_ONLY } from '../../../src/forge/gotcha.js';
import { classifyDiff, DEFAULT_PROTECTED_CAPABILITIES } from '../../../src/forge/self-iteration/classify.js';

describe('classifyDiff: denies by diff content, not by the reported where', () => {
  it('denies a diff touching hooks/*.py even when a gotcha\'s "where" names an unrelated fixable file', () => {
    // The gotcha itself is reported against a fixable file...
    const gotchaClassification = classifyGotcha({ where: 'src/forge/self-iteration/cluster.ts' });
    expect(gotchaClassification.lane).toBe('fix');

    // ...but the actual diff this gotcha's proposal would carry touches a hook too. A
    // classifier reading only `where` would never see this; classifyDiff reads the diff.
    const verdict = classifyDiff({ files: ['src/forge/self-iteration/cluster.ts', 'hooks/model_gate.py'] });

    expect(verdict.allow).toBe(false);
  });

  it('denies a change the path-only AARON_ONLY check would also have caught, proving nothing extra by itself', () => {
    const verdict = classifyDiff({ files: ['src/forge/model-policy.json'] });
    expect(verdict.allow).toBe(false);
  });

  it('is a strict superset of AARON_ONLY: every path it holds, this classifier holds too', () => {
    const examples = [
      'hooks/model_gate.py',
      'src/hooks/authorship_guard.py',
      'somewhere/authorship_guard.py',
      'src/forge/model-policy.json',
      'settings.json',
      'settings.portable.json',
      'install.ps1',
    ];
    for (const path of examples) {
      expect(AARON_ONLY.some((pattern) => pattern.test(path))).toBe(true);
      const verdict = classifyDiff({ files: [path] });
      expect(verdict.allow, `expected ${path} to be denied`).toBe(false);
    }
  });

  it('denies each of decision 6\'s own capability categories on a matching file', () => {
    const cases: Array<{ files: string[]; capability: string }> = [
      { files: ['src/forge/rules/gitflow.ts'], capability: 'permission' },
      { files: ['src/forge/council/gate.ts'], capability: 'merge' },
      { files: ['src/forge/registry.ts'], capability: 'coordination' },
      { files: ['src/forge/worker.ts'], capability: 'acceptance-oracle' },
    ];
    for (const { files, capability } of cases) {
      const verdict = classifyDiff({ files });
      expect(verdict.allow, `expected ${files.join(',')} to be denied`).toBe(false);
      if (!verdict.allow) expect(verdict.capability).toBe(capability);
    }
  });

  it('denies a credential-touching change detected only through added text, not the path', () => {
    const verdict = classifyDiff({
      files: ['src/forge/self-iteration/some-helper.ts'],
      addedText: 'const token = process.env.FORGE_JIRA_TOKEN;',
    });
    expect(verdict.allow).toBe(false);
  });

  it('allows a diff touching none of the protected categories', () => {
    const verdict = classifyDiff({ files: ['skills/some-skill/SKILL.md', 'docs/notes.md'] });
    expect(verdict.allow).toBe(true);
  });

  it('reads the classifier\'s own denial from the diff, never the proposal\'s self-description (falsifier for decision 6)', () => {
    // A proposal claiming (in its own body/description) that it "only touches docs" must
    // not be trusted -- the classifier is handed the actual file list, not that claim.
    const selfDescription = 'only touches docs';
    void selfDescription; // never passed to classifyDiff below
    const verdict = classifyDiff({ files: ['src/forge/council/gate.ts'] });
    expect(verdict.allow).toBe(false);
  });

  it('every default rule specifies at least one file pattern or symbol pattern', () => {
    for (const rule of DEFAULT_PROTECTED_CAPABILITIES) {
      expect(rule.filePatterns.length > 0 || (rule.symbolPatterns?.length ?? 0) > 0).toBe(true);
    }
  });
});
