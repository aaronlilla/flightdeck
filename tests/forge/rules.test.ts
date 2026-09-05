/**
 * Every Council rule, driven by its specimen corpus. A rule passes here only if it
 * denies each of its violating specimens and allows each of its passing ones.
 */
import { describe, expect, it } from 'vitest';

import { gitflowRule } from '../../src/forge/rules/gitflow.ts';
import { authorshipRule } from '../../src/forge/rules/authorship.ts';
import { humanizerRule } from '../../src/forge/rules/humanizer.ts';
import { sycophancyRule } from '../../src/forge/rules/sycophancy.ts';
import { vaguenessRule } from '../../src/forge/rules/vagueness.ts';
import type { Rule } from '../../src/forge/rules/types.ts';
import { GITFLOW_SPECIMENS } from './specimens/gitflow.ts';
import { AUTHORSHIP_SPECIMENS } from './specimens/authorship.ts';
import { HUMANIZER_SPECIMENS } from './specimens/humanizer.ts';
import { SYCOPHANCY_SPECIMENS } from './specimens/sycophancy.ts';
import { VAGUENESS_SPECIMENS } from './specimens/vagueness.ts';
import type { Specimen } from './specimens/gitflow.ts';

function runCorpus(rule: Rule, specimens: Specimen[]) {
  for (const specimen of specimens) {
    it(specimen.name, () => {
      const verdict = rule.evaluate(specimen.input);
      expect(verdict.allow ? 'allow' : 'deny').toBe(specimen.expect);
      if (!verdict.allow && specimen.reasonIncludes) {
        expect(verdict.reason.toLowerCase()).toContain(specimen.reasonIncludes.toLowerCase());
      }
    });
  }
}

describe('gitflow rule', () => {
  runCorpus(gitflowRule, GITFLOW_SPECIMENS);
});

describe('authorship rule', () => {
  runCorpus(authorshipRule, AUTHORSHIP_SPECIMENS);
});

describe('humanizer rule', () => {
  runCorpus(humanizerRule, HUMANIZER_SPECIMENS);
});

describe('sycophancy rule', () => {
  runCorpus(sycophancyRule, SYCOPHANCY_SPECIMENS);
});

describe('vagueness rule', () => {
  runCorpus(vaguenessRule, VAGUENESS_SPECIMENS);
});
