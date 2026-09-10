#!/usr/bin/env node
/**
 * `scripts/service-install.ps1`'s only job: call this, which reads the console's real
 * paths and `console.env.cmd`, generates the script text, and prints it to stdout. Kept
 * out of `cli.ts` on purpose -- item 1's guardrail limits that file to signal handling
 * and wiring, and this needs no `forge` subcommand of its own.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { forgeHome } from '../paths.js';
import { generateInstallScript, readInstallScriptInput } from './install-script.js';

function currentUser(): string {
  return process.env['USERDOMAIN'] && process.env['USERNAME']
    ? `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}`
    : (process.env['USERNAME'] ?? homedir());
}

const input = readInstallScriptInput({
  home: forgeHome(),
  consoleWorktree: process.env['FORGE_CONSOLE_WORKTREE'] ?? process.cwd(),
  serviceUser: process.env['FORGE_SERVICE_USER'] ?? currentUser(),
  envPath: join(forgeHome(), 'console.env.cmd'),
});

process.stdout.write(generateInstallScript(input));
