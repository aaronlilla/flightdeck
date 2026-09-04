#!/usr/bin/env node
/**
 * `forge` from a terminal.
 *
 *   forge up                  replay the journal, report, serve on 4120
 *   forge status              what every lane is doing, and what it costs
 *   forge run BRIEF           launch a goal, refusing the four launch mistakes
 *   forge send RUN TEXT       queue a message for a run already in flight
 *   forge answer KEY ANSWER   answer a question a worker parked on
 *   forge stop --all          park every run with a handoff and end all spend
 *
 * `stop --all` is the control that has to work when nothing else does, so it takes no
 * arguments it could get wrong, is safe to run twice, and says plainly when there was
 * nothing to stop. It parks rather than kills: the work survives and `forge up` continues
 * it. A stop that lost an afternoon is a stop nobody dares press.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCutover } from './cutover.js';
import { readProcessList, watchedProcesses } from './fleetwatch.js';
import { Gotchas } from './gotcha.js';
import { Inbox } from './inbox.js';
import { replay, Journal } from './journal.js';
import { checkLaunch, launchEnv, loginInFlight, pinnedRuntime, runtimeVersion } from './launcher.js';
import { assess, LivenessSupervisor } from './liveness.js';
import {
  ensureHome, fleetConfigDirChoice, forgeHome, gotchasDir, inboxDir, journalPath, lanesDir,
} from './paths.js';
import { RunInbox } from './runinbox.js';
import { SdkEngine } from './sdkengine.js';
import { FORGE_PORT, ForgeServer } from './server.js';
import { Breaker, Fleet, Lanes } from './supervisor.js';
import { Worker, type EngineLike } from './worker.js';

export interface CliResult {
  code: number;
  lines: string[];
}

export interface ForgeDeps {
  /** Overrides the production engine. Every specimen injects a fake here; nothing else may. */
  engine?: EngineLike;
}

/**
 * A fleet snapshot's runs, from the journal's own replayed state.
 *
 * Shared by `status` and `up` so there is exactly one place that reads a run's model-policy
 * class off `RunState` rather than assuming `implement` for every run.
 */
function snapshotRuns(state: ReturnType<typeof replay>): Array<{
  run: string; className: string; lastEventAt: number; context: number;
  currentTool?: { name: string; startedAt: number };
}> {
  // A finished, handed-off or parked run's lastEventAt is frozen at whatever it was when
  // it stopped, while `now` keeps moving; fed to assess() unfiltered, every one of them
  // trips the idle signal forever and LivenessSupervisor never clears it, since the trip
  // never stops reappearing. Only a run still actually going belongs in the snapshot.
  return Object.values(state.runs)
    .filter((run) => run.state === 'started')
    .map((run) => ({
      run: run.run, className: run.className ?? 'implement', lastEventAt: run.lastEventAt,
      context: run.context, ...(run.currentTool ? { currentTool: run.currentTool } : {}),
    }));
}

/**
 * `forge run`'s arguments past the brief path: `--dry-run`, `--max-context N`,
 * `--max-turns N`, and whatever words are left over become the condition.
 */
function parseRunArgs(rest: string[]): {
  dryRun: boolean; maxContext?: number; maxTurns?: number; condition: string;
} {
  let dryRun = false;
  let maxContext: number | undefined;
  let maxTurns: number | undefined;
  const words: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--dry-run') { dryRun = true; continue; }
    if (token === '--max-context') { maxContext = Number(rest[index += 1]); continue; }
    if (token === '--max-turns') { maxTurns = Number(rest[index += 1]); continue; }
    words.push(token);
  }
  return {
    dryRun, condition: words.join(' '),
    ...(maxContext !== undefined ? { maxContext } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
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
export async function forge(argv: string[], deps: ForgeDeps = {}): Promise<CliResult> {
  const [command, ...rest] = argv;
  ensureHome();
  const lanes = new Lanes(lanesDir());
  const inbox = new Inbox(inboxDir());

  switch (command) {
    case 'status': {
      const state = replay(journalPath());
      const stuckRows = assess({
        now: Date.now(), runs: snapshotRuns(state), fleet: watchedProcesses(),
      }).map((trip) => `STUCK  ${trip.key.padEnd(24)} ${trip.signal.padEnd(14)} ${trip.hint}`);
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
      if (!rows.length && !waiting && !state.torn && !stuckRows.length) {
        return { code: 0, lines: ['nothing is running'] };
      }
      if (state.torn) {
        rows.push(`journal: ${state.torn} torn line(s), which is a crash somebody should read`);
      }
      rows.push(`inbox: ${waiting} waiting`);
      return { code: 0, lines: [...stuckRows, ...rows] };
    }

    case 'up': {
      const state = replay(journalPath());
      const server = new ForgeServer({
        lanes, inbox, journalPath: journalPath(),
        stuck: () => liveness.stuck(),
        fleet: () => watchedProcesses().map((proc) => ({ ...proc })),
      });
      const livenessJournal = new Journal(journalPath());
      const liveness = new LivenessSupervisor(
        () => ({
          now: Date.now(),
          runs: snapshotRuns(replay(journalPath())),
          fleet: watchedProcesses(),
        }),
        livenessJournal,
        (event) => server.publish(event),
      );
      const port = await server.listen();
      const tick = setInterval(() => liveness.evaluate(), 30_000);
      tick.unref();
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
      const { dryRun, maxContext, maxTurns, condition } = parseRunArgs(rest.slice(1));
      const verdict = checkLaunch({
        brief,
        condition: condition || 'Work the brief to completion.',
        loginRunning: loginInFlight(),
      });
      if (!verdict.ok) {
        return { code: 1, lines: ['refusing to start:', ...verdict.refusals.map((r) => `  ${r}`)] };
      }
      const slug = briefPath.split(/[\\/]/).pop()!.replace(/\.md$/, '');
      const pin = pinnedRuntime(slug);
      const breaker = new Breaker(lanes);
      const configDir = fleetConfigDirChoice();
      const configDirLine = `config dir: ${configDir.dir} (${configDir.source})`;

      if (dryRun) {
        lanes.put(slug, { column: 'forge', started: Date.now() });
        return {
          code: 0,
          lines: [
            `${slug} pinned to forge ${pin.version}`,
            `CLAUDE_CONFIG_DIR=${launchEnv()['CLAUDE_CONFIG_DIR']}`,
            configDirLine,
          ],
        };
      }

      if (breaker.blocked(slug)) {
        return {
          code: 1,
          lines: [
            `refusing to start ${slug}: ${lanes.get(slug)?.needs_aaron}`,
            `run forge clear ${slug} once you have looked at why it kept failing to start`,
          ],
        };
      }

      lanes.put(slug, { column: 'forge', started: Date.now(), owner: 'forge' });
      const engine = deps.engine ?? new SdkEngine({
        journalPath: journalPath(), inboxDir: inboxDir(), gotchasDir: gotchasDir(),
      });
      const worker = new Worker({
        run: slug,
        brief,
        briefPath,
        cwd: process.cwd(),
        journalPath: journalPath(),
        engine,
        ...(maxContext !== undefined ? { maxContext } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      });
      let result: Awaited<ReturnType<Worker['run']>>;
      try {
        result = await worker.run();
      } finally {
        if (engine instanceof SdkEngine) engine.close();
      }
      const started = result.sessions[0];
      // A session that opened and closed without a single turn is a failed start, not a
      // worker being quiet; three of those in fifteen minutes is the exact 2026-09-03
      // thrash this breaker exists to stop, so it has to see every real launch.
      if (result.sessions.length === 1 && result.turns === 0) {
        breaker.noteZeroTurnStart(slug);
      } else {
        breaker.noteWorkingStart(slug);
      }
      lanes.put(slug, {
        column: 'forge', owner: 'forge', model: result.model, context: result.context,
        verdict: result.verdict, ...(started ? { session_id: started } : {}),
      });
      return {
        code: 0,
        lines: [
          `${slug} ${result.verdict} on ${result.model}, ${result.turns} turn(s), `
            + `${result.sessions.length} session(s), ${result.handoffs} handoff(s)`,
          configDirLine,
        ],
      };
    }

    case 'send': {
      const [run, ...text] = rest;
      if (!run || !text.length) return { code: 2, lines: ['forge send needs a run and text'] };
      new RunInbox(run).send(text.join(' '), 'console');
      return { code: 0, lines: [`queued for ${run}`] };
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

    case 'cutover': {
      const fromIndex = rest.indexOf('--from');
      const from = fromIndex >= 0 ? rest[fromIndex + 1] : process.env['FORGE_COORDINATION_DIR'];
      if (!from) {
        return {
          code: 2,
          lines: ['forge cutover needs --from DIR, or FORGE_COORDINATION_DIR set in the environment'],
        };
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const retiredDir = join(forgeHome(), 'retired', dateStr);
      const journal = new Journal(journalPath());
      let result: ReturnType<typeof runCutover>;
      try {
        result = runCutover({ from, retiredDir, processList: readProcessList() }, journal);
      } finally {
        journal.close();
      }
      if (!result.ok) return { code: 1, lines: [`refusing to cut over: ${result.refusal}`] };
      return {
        code: 0,
        lines: result.moved.length
          ? [`retired ${result.moved.length} file(s) to ${retiredDir}`, ...result.moved.map((f) => `  ${f}`)]
          : ['nothing to retire'],
      };
    }

    default:
      return {
        code: 2,
        lines: [
          'forge up | status | run BRIEF | send RUN TEXT | answer KEY ANSWER | stop --all '
            + '| gotchas | clear LANE | cutover [--from DIR]',
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
