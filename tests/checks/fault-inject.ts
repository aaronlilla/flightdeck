/**
 * Fault injection for flightdeck's own detectors.
 *
 * Standing order 2: a check counts only once it has been watched failing on a
 * deliberately broken specimen. A green contamination check on a clean repo is
 * not evidence that the check works. It is equally consistent with the check
 * being dead.
 *
 * So this harness writes poisoned files, runs the real detector over them, and
 * fails the build when a detector stays silent. It also runs negative controls,
 * because a detector that fires on everything is just as useless as one that
 * fires on nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanFiles } from './agnostic.ts';
import { runLive, runNeutered } from './neuter.ts';

interface Specimen {
  name: string;
  /** Contents written to a throwaway file. */
  content: string;
  /** Rule that must fire. Null means nothing may fire (a negative control). */
  expect: string | null;
}

const join = (...parts: string[]) => parts.join('');

const SPECIMENS: Specimen[] = [
  {
    name: 'employer name in a source file',
    content: `const repo = "${join('bolt', 'betz')}-harness";\n`,
    expect: 'project-specific-name',
  },
  {
    name: 'employer vault path',
    content: `# see ${join('bb', '-infra')}/docs for the note\n`,
    expect: 'project-specific-name',
  },
  // The poisoned paths below are assembled at run time for the same reason the
  // detector's own patterns are: written as literals they would make this file
  // a finding, and exempting it would blind the check to its own specimens.
  {
    name: 'drive rooted dev directory',
    content: `const root = "${join('C:/', 'dev')}/worktrees";\n`,
    expect: 'windows-dev-root',
  },
  {
    name: 'absolute windows home path',
    content: `HOOK = "${join('C:/Use', 'rs/aaron')}/.claude/hooks/model_gate.py"\n`,
    expect: 'absolute-home-windows',
  },
  {
    name: 'absolute windows home path with backslashes',
    content: `path = "${join('C:\\\\Use', 'rs\\\\aaron')}\\\\.claude"\n`,
    expect: 'absolute-home-windows',
  },
  {
    // An accounts registry entry pasted into source, the shape `forge accounts add`
    // takes: the config dir is a real home path and must be caught like any other.
    name: 'leaked account config dir',
    content: `{ "id": "fleet-b", "provider": "claude", "configDir": "${join('C:/Use', 'rs/aaron')}/.claude-fleet-b" }
`,
    expect: 'absolute-home-windows',
  },
  {
    name: 'absolute posix home path',
    content: `export CLAUDE_HOME=${join('/ho', 'me/aaron')}/.claude\n`,
    expect: 'absolute-home-posix',
  },
  {
    name: 'control: documentation placeholder for a home path',
    content: 'The check covers absolute home paths such as `C:/Users/<name>`.\n',
    expect: null,
  },
  {
    name: 'control: tilde relative home reference',
    content: 'Bootstrap links ~/.claude/skills into the checkout.\n',
    expect: null,
  },
  {
    name: 'control: environment variable expansion',
    content: 'const home = process.env.USERPROFILE ?? "$HOME";\n',
    expect: null,
  },
  {
    name: 'control: ordinary prose',
    content: 'The kernel routes each phase of work to its own model.\n',
    expect: null,
  },
];

export interface InjectionResult {
  name: string;
  expected: string | null;
  fired: string[];
  ok: boolean;
}

export function runInjections(): InjectionResult[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'flightdeck-faultinject-'));
  try {
    return SPECIMENS.map((specimen, index) => {
      const file = path.join(dir, `specimen-${index}.txt`);
      writeFileSync(file, specimen.content, 'utf8');
      const findings = scanFiles(dir, [file]);
      const fired = [...new Set(findings.map((f) => f.rule))];
      const ok =
        specimen.expect === null ? fired.length === 0 : fired.includes(specimen.expect);
      return { name: specimen.name, expected: specimen.expect, fired, ok };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  let failed = 0;

  const results = runInjections();
  console.log('fault injection: contamination detectors\n');
  for (const r of results) {
    const want = r.expected ?? '(silence)';
    const got = r.fired.length ? r.fired.join(', ') : '(silence)';
    if (r.ok) {
      console.log(`  PASS  ${r.name}\n        expected ${want}, got ${got}`);
    } else {
      failed += 1;
      console.error(`  FAIL  ${r.name}\n        expected ${want}, got ${got}`);
    }
  }

  // Second leg: switch each guard off and require its corpus to notice. A
  // corpus that stays green against a guard that does nothing is grading
  // itself, which is the sensor validity problem standing order 6 names.
  console.log('\nfault injection: guards neutered, corpus must object\n');
  const live = runLive();
  const dead = runNeutered();
  for (let i = 0; i < dead.length; i += 1) {
    const neutered = dead[i];
    const working = live[i];
    if (!neutered || !working) continue;
    if (working.mismatches.length > 0) {
      failed += 1;
      console.error(
        `  FAIL  ${working.guard}: corpus does not pass against the real guard\n` +
          working.mismatches.map((m) => `        ${m}`).join('\n'),
      );
      continue;
    }
    if (neutered.mismatches.length === 0) {
      failed += 1;
      console.error(
        `  FAIL  ${neutered.guard}: corpus still passes with the guard switched off. ` +
          'It is not testing anything.',
      );
      continue;
    }
    console.log(
      `  PASS  ${neutered.guard}: ${neutered.mismatches.length} of ${neutered.total} ` +
        'specimens object when the guard is switched off',
    );
  }

  console.log('');
  if (failed > 0) {
    console.error(
      `${failed} detector(s) did not behave as specified. A detector that does ` +
        'not fire on a broken specimen is not evidence of anything.',
    );
    process.exit(1);
  }
  console.log('every detector fired on its broken specimens and stayed quiet on its controls');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
