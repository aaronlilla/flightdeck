#!/usr/bin/env node
/**
 * `forge` from a terminal.
 *
 *   forge up                  replay the journal, report, serve on 4120
 *   forge status              what every lane is doing, and what it costs
 *   forge run BRIEF           launch a goal, refusing the four launch mistakes
 *   forge answer KEY ANSWER   answer a question a worker parked on
 *   forge stop --all          park every run with a handoff and end all spend
 *
 * `stop --all` is the control that has to work when nothing else does, so it takes no
 * arguments it could get wrong, is safe to run twice, and says plainly when there was
 * nothing to stop. It parks rather than kills: the work survives and `forge up` continues
 * it. A stop that lost an afternoon is a stop nobody dares press.
 */
import { readFileSync } from 'node:fs';

import { Gotchas } from './gotcha.js';
import { Inbox } from './inbox.js';
import { replay } from './journal.js';
import { checkLaunch, launchEnv, loginInFlight, pinnedRuntime, runtimeVersion } from './launcher.js';
import { ensureHome, gotchasDir, inboxDir, journalPath, lanesDir } from './paths.js';
import { FORGE_PORT, ForgeServer } from './server.js';
import { Breaker, Fleet, Lanes } from './supervisor.js';

export interface CliResult {
  code: number;
  lines: string[];
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Run one command and say what happened.
 *
 * Returns rather than printing, so the specimens can read the outcome and `main` stays
 * the only place that writes to a terminal.
 */
export async function forge(argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  ensureHome();
  const lanes = new Lanes(lanesDir());
  const inbox = new Inbox(inboxDir());

  switch (command) {
    case 'status': {
      const state = replay(journalPath());
      const rows = lanes.all().map((lane) => [
        lane.slug.padEnd(28),
        (lane.model ?? '-').padEnd(18),
        `ctx ${String(lane.context ?? 0).padStart(7)}`,
        money(lane.cost_usd ?? 0).padStart(9),
        lane.needs_aaron ? 'NEEDS AARON' : (lane.verdict ?? 'running'),
      ].join(' '));
      const waiting = inbox.open().length;
      // An idle fleet says one thing and stops. Appending "inbox: 0 waiting" to it made
      // "nothing is running" impossible to say, which is the answer a person most wants.
      if (!rows.length && !waiting && !state.torn) {
        return { code: 0, lines: ['nothing is running'] };
      }
      if (state.torn) {
        rows.push(`journal: ${state.torn} torn line(s), which is a crash somebody should read`);
      }
      rows.push(`inbox: ${waiting} waiting`);
      return { code: 0, lines: rows };
    }

    case 'up': {
      const state = replay(journalPath());
      const server = new ForgeServer({ lanes, inbox, journalPath: journalPath() });
      const port = await server.listen();
      return {
        code: 0,
        lines: [
          `forge ${runtimeVersion()} up on http://127.0.0.1:${port}`,
          `replayed ${state.events.length} events, ${Object.keys(state.runs).length} run(s)`,
          state.torn ? `${state.torn} torn journal line(s) survived and were skipped` : '',
          `inbox: ${inbox.open().length} waiting`,
        ].filter(Boolean),
      };
    }

    case 'run': {
      const briefPath = rest[0];
      if (!briefPath) return { code: 2, lines: ['forge run needs a brief path'] };
      let brief: string;
      try {
        brief = readFileSync(briefPath, 'utf8');
      } catch (error) {
        return { code: 2, lines: [`cannot read ${briefPath}: ${(error as Error).message}`] };
      }
      const verdict = checkLaunch({
        brief,
        condition: rest.slice(1).join(' ') || 'Work the brief to completion.',
        loginRunning: loginInFlight(),
      });
      if (!verdict.ok) {
        return { code: 1, lines: ['refusing to start:', ...verdict.refusals.map((r) => `  ${r}`)] };
      }
      const slug = briefPath.split(/[\\/]/).pop()!.replace(/\.md$/, '');
      const pin = pinnedRuntime(slug);
      lanes.put(slug, { column: 'forge', started: Date.now() });
      return {
        code: 0,
        lines: [
          `${slug} pinned to forge ${pin.version}`,
          `CLAUDE_CONFIG_DIR=${launchEnv()['CLAUDE_CONFIG_DIR']}`,
        ],
      };
    }

    case 'answer': {
      const [key, ...answer] = rest;
      if (!key || !answer.length) {
        return { code: 2, lines: ['forge answer needs a key and an answer'] };
      }
      const answered = inbox.answer(key, answer.join(' '));
      if (!answered) return { code: 1, lines: [`nothing asked ${key}`] };
      return { code: 0, lines: [`answered ${key}; ${answered.runs.join(', ')} can resume`] };
    }

    case 'stop': {
      if (!rest.includes('--all')) {
        return { code: 2, lines: ['forge stop --all is the only form; it parks everything'] };
      }
      const reason = rest.filter((word) => word !== '--all').join(' ') || 'stopped by hand';
      const stopped = new Fleet(lanes, journalPath()).stopAll(reason);
      if (!stopped.length) return { code: 0, lines: ['nothing was running'] };
      return {
        code: 0,
        lines: [
          `parked ${stopped.length} run(s) with a handoff; all spend has stopped`,
          ...stopped.map((lane) => `  ${lane.slug}`),
        ],
      };
    }

    case 'gotchas': {
      const filed = new Gotchas(gotchasDir(), journalPath()).all();
      return {
        code: 0,
        lines: filed.length
          ? filed.map((g) => `${g.lane.padEnd(6)} ${String(g.hits).padStart(3)}x  ${g.what}`)
          : ['no gotchas filed'],
      };
    }

    case 'clear': {
      const slug = rest[0];
      if (!slug) return { code: 2, lines: ['forge clear needs a lane'] };
      new Breaker(lanes).clear(slug);
      return { code: 0, lines: [`${slug} may be relaunched again`] };
    }

    default:
      return {
        code: 2,
        lines: [
          'forge up | status | run BRIEF | answer KEY ANSWER | stop --all | gotchas | clear LANE',
          `the server listens on ${FORGE_PORT}`,
        ],
      };
  }
}

/* c8 ignore start */
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  forge(process.argv.slice(2)).then((result) => {
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    process.exitCode = result.code;
  });
}
/* c8 ignore stop */
