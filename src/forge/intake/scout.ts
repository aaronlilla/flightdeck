/**
 * The scout: answers an interview question that only the checked-out code can answer,
 * so a question about the repository never costs a person a round trip (roadmap R-76).
 *
 * There is no repository-read tool surface for a reasoner in this codebase -- the
 * Conductor agent's tools read lanes, not files -- so the scout reads the checkout
 * itself: one `git grep -n` for the question's own terms, up to `MAX_FILES` of the files
 * that came back, each capped at `TAIL_BYTES`, handed to a `research`-class reasoner call
 * that must cite `file:line` or say plainly that it cannot answer.
 *
 * Both seams are injected (`execRun`, `readFile`), so no specimen in this repository
 * runs git or touches a working tree.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { Reasoner } from '../contracts.ts';
import { TAIL_BYTES, run as execRunDefault, type RunRequest, type RunResult } from '../exec.ts';
import type { InterviewQuestion } from './interview.ts';

export type ExecRunFn = (request: RunRequest) => Promise<RunResult>;
export type ReadFileFn = (path: string) => string;

/** How many of the grep's own files the scout is willing to read before answering. More
 *  than this and the question is too broad to answer from a grep anyway. */
export const MAX_FILES = 5;

/** How many terms a question contributes to the grep. A question wide enough to need
 *  more is one a person should answer. */
const MAX_TERMS = 4;

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'been', 'before', 'being', 'between',
  'both', 'does', 'doing', 'down', 'during', 'each', 'from', 'have', 'here', 'into',
  'only', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would',
  'your', 'we', 'do', 'is', 'are', 'the', 'and', 'or', 'if', 'it',
]);

/** The words a grep is run for: identifier-shaped tokens first (a `camelCase`, a
 *  `snake_case`, a dotted path), then ordinary words, stopwords dropped. Exported so a
 *  specimen can assert the grep it expects without restating this heuristic. */
export function termsFor(question: string): string[] {
  const tokens = question.match(/[A-Za-z_][A-Za-z0-9_.\-/]{2,}/g) ?? [];
  const identifiers: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/[A-Z_./-]/.test(token.slice(1)) || /[_./-]/.test(token)) identifiers.push(token);
    else words.push(token);
  }
  const ordered = [...identifiers, ...words];
  const seen = new Set<string>();
  const unique = ordered.filter((t) => {
    const lower = t.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
  return unique.slice(0, MAX_TERMS);
}

export interface ScoutDeps {
  /** The checkout the grep runs in. */
  cwd: string;
  reasoner: Reasoner;
  /** Names the command's log. */
  owner: string;
  execRun?: ExecRunFn;
  readFile?: ReadFileFn;
}

export interface ScoutAnswer {
  answered: boolean;
  /** The answer when `answered`, otherwise one line saying what the scout looked at and
   *  why it could not decide -- attached to the ask the caller raises instead. */
  text: string;
  citation?: string;
}

/** The `file:line` prefixes `git grep -n` writes, in the order they came back. */
function filesFromGrep(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^:]+):\d+:/.exec(line.trim());
    if (!match) continue;
    const file = match[1]!;
    if (!files.includes(file)) files.push(file);
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

export function buildScoutPrompt(question: InterviewQuestion, grep: string, files: { path: string; text: string }[]): string {
  return [
    'You are reading one checkout to answer one question about it. Answer only from the',
    'evidence below. If it does not settle the question, say so plainly -- a wrong answer',
    'here becomes a plan nobody questions.',
    '',
    `Question: ${question.text}`,
    ...(question.options.length ? [`Options: ${question.options.join(' | ')}`] : []),
    '',
    'git grep:',
    grep || '(no matches)',
    '',
    ...files.flatMap((file) => ['', `--- ${file.path}`, file.text]),
    '',
    'Reply with JSON only:',
    '{"answered":true|false,"answer":"...","citation":"path/to/file.ts:42"}',
  ].join('\n');
}

/**
 * One question, one grep, one reasoner call. Never raises an ask and never writes
 * anything: a scout that cannot answer says so, and the caller turns that into a
 * question for a person with the scout's own note attached.
 */
export async function scoutAnswer(question: InterviewQuestion, deps: ScoutDeps): Promise<ScoutAnswer> {
  const terms = termsFor(question.text);
  if (!terms.length) {
    return { answered: false, text: 'nothing in the question was specific enough to search the checkout for' };
  }
  const execRun = deps.execRun ?? execRunDefault;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const argv = ['git', 'grep', '-n', '-I', '-i', ...terms.flatMap((term) => ['-e', term])];
  // `fullOutput` matters: without it `full` is always undefined and the whole grep is cut
  // to its last 4 KB, so "the first five files it named" silently became "the last five",
  // and the tail's first line is a mid-line fragment the file regex can match wrongly.
  // Found by code review, 2026-09-11.
  const grep = await execRun({
    argv, cwd: deps.cwd, owner: deps.owner, cls: 'script', raw: true, fullOutput: true,
  });
  // `git grep` exits 1 for "no matches" and 128 for a cwd that is not a repository, and
  // `exec.run` resolves on both. Treating them alike let a broken checkout path read as
  // "the code says nothing about this", which is exactly the answer nobody should get
  // from a directory that was never searched.
  if (grep.returncode !== 0 && grep.returncode !== 1) {
    return {
      answered: false,
      text: `could not search the checkout at ${deps.cwd} (git grep exited ${grep.returncode ?? 'without a code'})`,
    };
  }
  const output = grep.full ?? grep.tail ?? '';

  const files: { path: string; text: string }[] = [];
  for (const relative of filesFromGrep(output)) {
    const path = isAbsolute(relative) ? relative : join(deps.cwd, relative);
    try {
      files.push({ path: relative, text: readFile(path).slice(0, TAIL_BYTES) });
    } catch {
      // a file the grep named and the tree no longer has is evidence of nothing
    }
  }

  const reply = await deps.reasoner.call({
    className: 'research', prompt: buildScoutPrompt(question, output, files),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    return { answered: false, text: `read ${files.length} file(s) and could not settle it` };
  }
  const row = (parsed ?? {}) as Record<string, unknown>;
  const answer = typeof row['answer'] === 'string' ? row['answer'] : '';
  const citation = typeof row['citation'] === 'string' ? row['citation'] : '';
  if (row['answered'] !== true || !answer) {
    return { answered: false, text: answer || `read ${files.length} file(s) and could not settle it` };
  }
  return { answered: true, text: answer, ...(citation ? { citation } : {}) };
}
