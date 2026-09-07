/**
 * After a Merge click lands on the develop line, the deploy workflow fingerprints each
 * platform and either publishes an OTA or builds. This reads that outcome off the EAS
 * CLI so the queue item can say what actually happened per platform, never a version
 * number and never a guess (an OTA that reached one platform is a defect, not a success).
 *
 * The CLI has no JSON mode for these commands, so the parsers below are built on the
 * text it prints: `workflow:runs` lists runs as "Key   Value" blocks separated by blank
 * lines; `workflow:view <id>` prints the run block, then one "Job ID" block per job with
 * an optional indented "Outputs:" table. Every `eas` call needs a project checkout as
 * its cwd. Each call is capped; the whole wait is capped; a run that never appears
 * yields `undefined`, and the caller says so in the item's reason.
 */

export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: string;
  startedAt: number | undefined;
}

export interface WorkflowJob {
  key: string;
  status: string;
  outputs: Record<string, string>;
}

export interface WorkflowView {
  runId: string | undefined;
  workflow: string | undefined;
  status: string | undefined;
  triggerSha: string | undefined;
  jobs: WorkflowJob[];
}

const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'CANCELED', 'CANCELLED', 'ERRORED']);

function field(block: string, label: string): string | undefined {
  // Label and value are separated by a run of at least two spaces; a value is the rest
  // of that line.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('^[ \\t]*' + escaped + '[ \\t]{2,}(.*)$', 'm'));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

export function parseWorkflowRuns(text: string): WorkflowRun[] {
  return text.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => /^Run ID/m.test(block)).map((block) => {
    const started = field(block, 'Started At');
    return {
      runId: field(block, 'Run ID') ?? '',
      workflow: field(block, 'Workflow') ?? '',
      status: field(block, 'Status') ?? '',
      startedAt: started ? Date.parse(started) : undefined,
    };
  }).filter((run) => run.runId);
}

export function parseWorkflowView(text: string): WorkflowView {
  const [head = '', ...jobBlocks] = text.split(/\n(?=Job ID)/);
  const trigger = field(head, 'Trigger');
  const jobs = jobBlocks.map((block): WorkflowJob => {
    const outputs: Record<string, string> = {};
    const outputsStart = block.indexOf('Outputs:');
    if (outputsStart >= 0) {
      for (const line of block.slice(outputsStart + 'Outputs:'.length).split('\n')) {
        const match = line.match(/^\s{4}(\S+)\s+(.*)$/);
        if (match) outputs[match[1]!] = match[2]!.trim();
      }
    }
    return { key: field(block, 'Key') ?? '', status: field(block, 'Status') ?? '', outputs };
  });
  return {
    runId: field(head, 'Run ID'),
    workflow: field(head, 'Workflow'),
    status: field(head, 'Status'),
    triggerSha: trigger?.includes('@') ? trigger.slice(trigger.lastIndexOf('@') + 1) : undefined,
    jobs,
  };
}

/** Each platform as "<action> <fingerprint prefix>", read from the decide job's outputs;
 *  undefined until that job has produced them. */
export function otaOutcome(view: WorkflowView): { ios: string; android: string } | undefined {
  const decide = view.jobs.find((job) => job.key === 'decide');
  if (!decide) return undefined;
  const { ios_action, android_action, ios_hash, android_hash } = decide.outputs;
  if (!ios_action || !android_action) return undefined;
  const short = (hash: string | undefined): string => (hash ? hash.slice(0, 8) : 'no-hash');
  return { ios: `${ios_action} ${short(ios_hash)}`, android: `${android_action} ${short(android_hash)}` };
}

export interface VerifierOptions {
  /** A project checkout: every `eas` command refuses to run outside one. */
  checkout: string;
  workflow: string;
  exec: (argv: string[], cwd: string) => Promise<string>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface VerifyInput {
  repo: string;
  branch: string;
  /** When the merge landed; only a run started at or after this counts. */
  mergedAt: number;
}

/** Builds the queue's `postMergeVerify`: waits for the deploy run this merge triggered
 *  and returns its per-platform outcome, or undefined when none starts inside the wait. */
export function developDeployVerifier(opts: VerifierOptions) {
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? 30_000;
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;

  return async (input: VerifyInput): Promise<{ ios: string; android: string } | undefined> => {
    const deadline = clock() + maxWaitMs;
    // A run's own clock can lead the merge's by a little; a minute of slack keeps a run
    // that started while the merge response was still in flight.
    const notBefore = input.mergedAt - 60_000;
    let runId: string | undefined;
    // Bounded twice: by the clock and by a poll count, so a clock that does not advance
    // (a fake in a test, a frozen host) still cannot spin this loop forever.
    const maxPolls = Math.ceil(maxWaitMs / Math.max(pollMs, 1)) + 1;
    for (let poll = 0; poll < maxPolls && clock() < deadline; poll += 1) {
      if (!runId) {
        const listing = await opts.exec(['npx', 'eas-cli', 'workflow:runs', '--limit', '8'], opts.checkout);
        const run = parseWorkflowRuns(listing)
          .filter((r) => r.workflow === opts.workflow && r.startedAt !== undefined && r.startedAt >= notBefore)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
        runId = run?.runId;
      }
      if (runId) {
        const view = parseWorkflowView(await opts.exec(['npx', 'eas-cli', 'workflow:view', runId], opts.checkout));
        const outcome = otaOutcome(view);
        if (outcome && (view.status === undefined || TERMINAL.has(view.status))) return outcome;
        if (view.status && TERMINAL.has(view.status)) return outcome;
      }
      await sleep(pollMs);
    }
    return undefined;
  };
}
