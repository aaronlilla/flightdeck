#!/usr/bin/env node
/**
 * Entry point.
 *
 * Three jobs: wire this machine up (bootstrap), report whether it is still
 * wired up (verify), and fly (the default).
 */
import { render } from 'ink';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';

import { apply, describe, isSettled, planFor, verify } from './bootstrap/links.ts';
import {
  applySettings,
  describeSettings,
  inspectSettings,
  settingsPlan,
} from './bootstrap/settings.ts';
import { App } from './cockpit/app.tsx';
import { loadOverlays } from './overlay/overlays.ts';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const HELP = `flightdeck

  flightdeck                 open the cockpit in the current directory
  flightdeck --resume <id>   open it on an existing session
  flightdeck bootstrap       link this machine's Claude home into the checkout
  flightdeck verify          report whether the links are still intact
  flightdeck overlays        list the overlays this machine loads
  flightdeck help            this text

Bootstrap links rather than copies, so editing doctrine in the checkout is live
everywhere at once and a pull is the whole sync. It links one skill at a time
and never overwrites what it finds. Anything this machine already had stays,
including a skill that shares a name with one in the checkout: that copy is
there for a reason, and the checkout does not get to guess what it was.
`;

function bootstrap(): number {
  const reports = apply(planFor(repoRoot));
  const settings = applySettings(settingsPlan(repoRoot));

  console.log('bootstrap\n');
  console.log(describe(reports));
  console.log(describeSettings(settings));

  const kept = reports.filter(
    (r) => r.status === 'machine-only' || r.status === 'machine-differs',
  );
  const outstanding = reports.filter((r) => !isSettled(r.status));

  console.log('');
  if (kept.length) {
    console.log(
      `left ${kept.length} as this machine had them. Bootstrap does not overwrite ` +
        'what it finds, so anything here that came from somewhere else stays.',
    );
  }

  for (const report of outstanding) {
    console.error(`${report.plan.target}: ${report.detail}`);
  }
  if (settings.status === 'unreadable') console.error(settings.detail);

  if (outstanding.length || settings.status === 'unreadable') return 1;
  console.log('linked. an edit in the checkout is live everywhere.');
  return 0;
}

function verifyLinks(): number {
  const reports = verify(planFor(repoRoot));
  const settings = inspectSettings(settingsPlan(repoRoot));
  console.log('verify\n');
  console.log(describe(reports));
  console.log(describeSettings(settings));

  const bad = reports.filter((r) => !isSettled(r.status));
  console.log('');
  if (bad.length === 0 && settings.status !== 'added') {
    console.log('every link points into the checkout.');
    return 0;
  }
  if (bad.length) {
    console.error(`${bad.length} of ${reports.length} are not wired up. Run: flightdeck bootstrap`);
  }
  if (settings.status === 'added') {
    console.error(`${settings.added.length} plugins are declared but not enabled here.`);
  }
  return 1;
}

function listOverlays(): number {
  const load = loadOverlays();
  if (!load.manifestFound) {
    console.log(`no overlay manifest at ${load.manifestPath}`);
    console.log('That file is machine local and never committed. Absent means no overlays.');
    return 0;
  }
  for (const overlay of load.overlays) {
    console.log(`${overlay.name}\n  root   ${overlay.root}`);
    if (overlay.skillDirs.length) console.log(`  skills ${overlay.skillDirs.join(', ')}`);
    if (overlay.authorshipExempt.length) {
      console.log(`  exempt ${overlay.authorshipExempt.join(', ')}`);
    }
  }
  for (const problem of load.problems) console.error(`problem: ${problem}`);
  return load.problems.length ? 1 : 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (command === 'bootstrap') {
    process.exitCode = bootstrap();
    return;
  }
  if (command === 'verify') {
    process.exitCode = verifyLinks();
    return;
  }
  if (command === 'overlays') {
    process.exitCode = listOverlays();
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      'flightdeck needs an interactive terminal. For scripted runs use the Claude CLI.',
    );
    process.exitCode = 1;
    return;
  }

  const resumeAt = argv.indexOf('--resume');
  const resume = resumeAt >= 0 ? argv[resumeAt + 1] : undefined;
  render(<App cwd={process.cwd()} {...(resume ? { resume } : {})} />);
}

main();
