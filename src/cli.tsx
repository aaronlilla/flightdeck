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

import { apply, describe, planFor, verify } from './bootstrap/links.ts';
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
everywhere at once and a pull is the whole sync. It refuses to replace a real
directory unless you pass --force, because that directory is somebody's setup.
`;

function bootstrap(force: boolean): number {
  const reports = apply(planFor(repoRoot), { force });
  console.log('bootstrap\n');
  console.log(describe(reports));
  const bad = reports.filter((r) => r.status !== 'ok');
  if (bad.length === 0) {
    console.log('\nlinked. an edit in the checkout is live everywhere.');
    return 0;
  }
  console.log('');
  for (const report of bad) {
    if (report.status === 'occupied') {
      console.error(
        `${report.plan.target} already exists as a real directory. Move it aside, or ` +
          're-run with --force to replace it.',
      );
    } else if (report.status === 'source-missing') {
      console.error(`${report.plan.source} is missing from the checkout.`);
    } else {
      console.error(`${report.plan.target}: ${report.detail}`);
    }
  }
  return 1;
}

function verifyLinks(): number {
  const reports = verify(planFor(repoRoot));
  console.log('verify\n');
  console.log(describe(reports));
  const bad = reports.filter((r) => r.status !== 'ok');
  console.log('');
  if (bad.length === 0) {
    console.log('every link points into the checkout.');
    return 0;
  }
  console.error(`${bad.length} of ${reports.length} are not wired up. Run: flightdeck bootstrap`);
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
    process.exitCode = bootstrap(argv.includes('--force'));
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
