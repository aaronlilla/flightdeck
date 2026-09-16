/**
 * The blind-external-bar lens.
 *
 * Every other lens grades a diff against rules this system already holds. That is
 * exactly the failure mode this run kept hitting: a rubric can only find the faults it
 * already knows to name, and both real defects this run uncovered were found instead by
 * putting our artifact next to a competitor's with the labels stripped and asking which
 * one a maintainer would rather receive.
 *
 * So this lens holds a corpus of REAL pull requests authored by an autonomous agent on a
 * public repository, merged by real maintainers, and asks the reviewer to judge ours
 * against those artifacts rather than against a description of good practice.
 *
 * The corpus is a baseline, not a target. Some of those bodies are mostly
 * self-congratulation ("the issue has been successfully resolved") with no evidence a
 * reader can check, and a lens that imitated them would be worse than one following a
 * rubric. The prompt therefore asks explicitly which artifact gives a maintainer more
 * checkable evidence -- and says plainly that the corpus may lose.
 */
import { readFileSync } from 'node:fs';

export interface CorpusEntry {
  number: number;
  title: string;
  body: string;
  bodyChars: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  testFiles: number;
  testLines: number;
}

export interface Corpus {
  repo: string;
  total: number;
  corpus: CorpusEntry[];
}

export const BAR_LENS_NAME = 'external-bar';

/** Reads the corpus, or returns undefined so a missing file degrades to no lens. */
export function loadCorpus(path: string): Corpus | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
    return parsed.corpus?.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Median, so one outlier PR cannot move the baseline. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export interface CorpusShape {
  count: number;
  medianBodyChars: number;
  medianFiles: number;
  medianAdditions: number;
  withTests: string;
}

export function corpusShape(corpus: Corpus): CorpusShape {
  const entries = corpus.corpus;
  return {
    count: entries.length,
    medianBodyChars: median(entries.map((e) => e.bodyChars)),
    medianFiles: median(entries.map((e) => e.changedFiles)),
    medianAdditions: median(entries.map((e) => e.additions)),
    withTests: `${entries.filter((e) => e.testFiles > 0).length}/${entries.length}`,
  };
}

/**
 * Picks the corpus entries closest in size to the diff under review, so the comparison
 * is like-for-like: a 30-line fix judged against a 900-line refactor tells a reviewer
 * nothing about either.
 */
export function comparableEntries(
  corpus: Corpus, changedLines: number, take = 3,
): CorpusEntry[] {
  return [...corpus.corpus]
    .sort((a, b) => Math.abs((a.additions + a.deletions) - changedLines)
      - Math.abs((b.additions + b.deletions) - changedLines))
    .slice(0, take);
}

export interface BarLensInput {
  /** Our PR body, unlabelled. */
  brief: string;
  diffSummary: string;
  changedLines: number;
  corpus: Corpus;
}

/**
 * How many test blocks the diff actually ADDS.
 *
 * Counted here, in TypeScript, rather than left to the model. The lens's one verified
 * finding to date was arithmetic -- a body claiming "6 passed" over a diff a reader
 * would count 5 test blocks in -- and asking an LLM to count occurrences in prose is
 * the least reliable thing it does. Computing the fact and asking the model only to
 * explain the discrepancy turns a coin flip into a check.
 */
export function countTestBlocks(diffSummary: string): number {
  let count = 0;
  for (const line of diffSummary.split(/\r?\n/)) {
    // Added lines only: a removed or context test block is not what this diff ships.
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    count += (line.match(/\b(?:test|it)\s*\(/g) ?? []).length;
  }
  return count;
}

/**
 * The test count the body claims, read from a "N passed" style assertion.
 *
 * Returns undefined when the body makes no countable claim, which is not a fault --
 * only a mismatch between a stated number and the diff is.
 */
export function parseClaimedTestCount(brief: string): number | undefined {
  const match = /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i.exec(brief);
  return match ? Number(match[1]) : undefined;
}

export function buildBarLensPrompt(input: BarLensInput): string {
  const shape = corpusShape(input.corpus);
  const peers = comparableEntries(input.corpus, input.changedLines);
  const addedTests = countTestBlocks(input.diffSummary);
  const claimedTests = parseClaimedTestCount(input.brief);

  return [
    `You are the "${BAR_LENS_NAME}" lens of a pull request council.`,
    '',
    'Every other lens on this council grades a diff against rules the system already',
    'holds, so it can only find faults someone thought to write down. Your job is',
    'different: you hold real pull requests that an autonomous agent opened on a public',
    'repository and that real maintainers merged, and you judge ours against those',
    'artifacts rather than against a description of good practice.',
    '',
    'Treat the corpus as a baseline, NOT a target. Some of these bodies assert success',
    'without evidence a reader can check. If ours is better, say so and do not invent a',
    'fault to look rigorous. If ours is worse, say exactly which artifact a maintainer',
    'would rather receive and why.',
    '',
    `Corpus shape (${shape.count} merged agent PRs from ${input.corpus.repo}, of`,
    `${input.corpus.total} found): median body ${shape.medianBodyChars} chars,`,
    `${shape.medianFiles} files changed, +${shape.medianAdditions} lines,`,
    `${shape.withTests} shipped with a test file.`,
    '',
    'The closest comparable merged PRs, verbatim:',
    ...peers.flatMap((peer) => [
      '',
      `--- merged PR, ${peer.changedFiles} files, +${peer.additions}/-${peer.deletions},`
        + ` ${peer.testFiles} test file(s) ---`,
      peer.body.slice(0, 1800),
    ]),
    '',
    '--- the artifact under review ---',
    input.brief,
    '',
    'Its diff:',
    input.diffSummary,
    '',
    `MEASURED (computed from the diff, not your reading): it adds ${addedTests} test`,
    claimedTests === undefined
      ? 'block(s), and the body states no countable pass total.'
      : `block(s), and the body claims ${claimedTests} passed.`
        + (claimedTests === addedTests
          ? ' Those reconcile.'
          : ' Those do NOT reconcile -- explain the gap, or say which figure is wrong.'),
    '',
    'Judge on exactly this: which artifact gives a maintainer more evidence they can',
    'check without reading the transcript? Specifically -- does it prove the new tests',
    'fail against the unfixed code, or merely claim tests were added? Does it state the',
    'blast radius and what is deliberately out of scope? Does it contain sentences about',
    'the author\'s own confidence rather than about the code?',
    '',
    'Set your `text` field to a JSON array of findings and nothing else. Each finding is',
    `shaped exactly as {"member": "${BAR_LENS_NAME}", "file": string, "line": integer,`,
    '"claim": string, "failureScenario": string, "severity": "critical"|"high"|"medium"|"low",',
    '"confidence": "low"|"medium"|"high"}. An empty array means ours holds up against the',
    'corpus. Cite the comparison in `claim`: name what a merged PR did that ours does not,',
    'or vice versa.',
  ].join('\n');
}
