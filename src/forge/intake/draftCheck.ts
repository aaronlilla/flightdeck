/**
 * One pass over every outward text a single work item produces, run BEFORE any write is
 * attempted.
 *
 * The problem it exists for: the readability contract and the authorship guard both speak
 * only at write time. A commit message, a pull request body and an issue comment are three
 * separate texts with three different contracts, so an author discovers each refusal after
 * the draft is already finished and rewrites one surface at a time. On one ticket that was
 * five rewrites between three texts -- two refusals on the pull request body (undocumented
 * production files, then 174 prose words against a 150-word ceiling) and one on the issue
 * comment (157 words against 80).
 *
 * This module reports, it never rewrites. And it derives nothing of its own: every ceiling,
 * banned word and required section comes from `readabilityVerdict`, which reads the same
 * installed `contract.json` the write-time guard reads, so the two can never disagree. A
 * ceiling changed in that file changes the number reported here on the next load.
 */
import { findAttribution } from '../../kernel/guards/authorship.ts';
import {
  readabilityVerdict,
  getReadabilityContractState,
  hasSecretShape,
  repoNameFrom,
  type DiffStatEntry,
  type ReadabilityVerdictKind,
} from './readability.ts';

/** The surfaces one work item writes. `commit-message` is not a readability surface (it
 *  has no prose ceiling and no required sections) but it IS an authorship surface and it
 *  is checked for banned words, so it belongs in the same pass. */
export type DraftSurface =
  | 'commit-message'
  | 'pr-title'
  | 'pr-body'
  | 'pr-comment'
  | 'pr-review'
  | 'jira-comment'
  | 'jira-description';

/** Fixed order so a report always reads in the order the texts are written. */
const SURFACE_ORDER: DraftSurface[] = [
  'commit-message', 'pr-title', 'pr-body', 'pr-comment', 'pr-review', 'jira-comment', 'jira-description',
];

export interface OutwardDraft {
  /** Repo slug or path; `owner/name` and a checkout path both work. */
  repo: string | null;
  /** The diff the pull request carries, for the undocumented-file and size checks.
   *  `null` means "could not measure" and is reported as such; `undefined` means "not
   *  applicable to this draft" and skips those checks entirely. */
  diffStats?: DiffStatEntry[] | null;
  texts: Partial<Record<DraftSurface, string>>;
}

export interface DraftFinding {
  surface: DraftSurface;
  verdict: 'DENY' | 'ADVISE';
  /** The write-time reason verbatim, which already names the count and the ceiling. */
  reason: string;
}

export interface DraftReport {
  findings: DraftFinding[];
  /** Every in-scope surface, so all of them are shaped in ONE humanizer pass instead of
   *  one pass per write. */
  humanize: DraftSurface[];
}

/** An issue surface is always in scope; a repo surface only on an outward-facing repo.
 *  Mirrors `readabilityVerdict`'s own scope rule rather than restating it, so a repo
 *  added to the contract widens both at once. */
function inScope(surface: DraftSurface, repo: string | null): boolean {
  if (surface.startsWith('jira')) return true;
  const state = getReadabilityContractState();
  if (!state.ok) return false;
  return repo !== null && state.contract.outward_repos.includes(repo);
}

/**
 * Every refusal the write-time gates would raise, in one pass. `asOf` is the date the
 * contract's date-gated checks are measured against -- the caller passes today's date;
 * a specimen passes a fixed one.
 */
export function checkOutwardDraft(draft: OutwardDraft, asOf: string): DraftReport {
  const repo = repoNameFrom(draft.repo);
  const findings: DraftFinding[] = [];
  const humanize: DraftSurface[] = [];

  // A missing contract must never read as a pass. Every repo surface would fall out of
  // scope and the report would print "no refusal", asserting a contract was applied when
  // none was loaded (review, 2026-09-12). Issue surfaces are still checked below, because
  // `readabilityVerdict` answers SILENT for them too and the authorship check does not
  // need a contract at all.
  const contract = getReadabilityContractState();
  if (!contract.ok) {
    findings.push({
      surface: 'pr-body',
      verdict: 'ADVISE',
      reason: `the readability contract is not loaded (${contract.reason}), so nothing was measured `
        + 'against it; this is not a pass',
    });
  }

  for (const surface of SURFACE_ORDER) {
    const text = draft.texts[surface];
    if (text === undefined) continue;

    // Order 13 binds everywhere, on every repo, so this runs before any scope test.
    const attribution = findAttribution(text);
    if (attribution) {
      findings.push({
        surface,
        verdict: 'DENY',
        reason: `machine authorship claim in the ${surface}: ${attribution.label}`,
      });
    }

    if (!inScope(surface, repo)) continue;
    humanize.push(surface);

    // A commit message is NOT a readability surface. The contract does not list it, and
    // no write-time rule checks one -- the only shell-side rule looks at `gh pr` calls.
    // Running the banned-word check on it here would refuse a commit for a word nothing
    // else refuses, which is the opposite of this module's whole point (review,
    // 2026-09-12). Authorship, above, and a pasted secret are what a commit message is
    // genuinely refused for.
    if (surface === 'commit-message') {
      const secret = hasSecretShape(text);
      if (secret.hit) {
        findings.push({
          surface,
          verdict: 'DENY',
          reason: `secret-shaped token in the commit message ("${secret.match}")`,
        });
      }
      continue;
    }

    // A title carries the ticket-key rule; a body carries sections, files and the prose
    // ceiling. Each surface is measured on its own text only, so a banned word in the
    // title is reported once against the title rather than again against the body.
    const isBody = surface === 'pr-body' || surface === 'jira-description';
    const title = surface === 'pr-title' ? text : '';
    const body = surface === 'pr-title' ? '' : text;
    // A body with no diff supplied is `null`, never `undefined`. `undefined` skips the
    // undocumented-production-path check and the size ceiling in silence, and those are
    // half of what a pull request body is refused for; `null` reports "cannot measure"
    // (review, 2026-09-12).
    const diffStats = isBody ? (draft.diffStats ?? null) : undefined;

    const result = readabilityVerdict(surface, repo, title, body, diffStats, asOf);
    if (result.verdict === 'DENY' || result.verdict === 'ADVISE') {
      findings.push({ surface, verdict: result.verdict as Exclude<ReadabilityVerdictKind, 'SILENT'>, reason: result.reason });
    }
  }

  return { findings, humanize };
}

/** One line per refusal, plus the single humanizer pass to run. Plain text: this is read
 *  by whoever is about to write, not parsed. */
export function draftReportLines(report: DraftReport): string[] {
  const lines: string[] = [];
  if (report.findings.length === 0) {
    lines.push('no refusal: every draft surface passes the contract as written.');
  } else {
    for (const finding of report.findings) {
      lines.push(`${finding.verdict} ${finding.surface}: ${finding.reason}`);
    }
  }
  if (report.humanize.length > 0) {
    lines.push(`humanize together (one pass): ${report.humanize.join(', ')}`);
  }
  return lines;
}

/** The same report as one block of text, for a caller that wants to print it whole. */
export function formatDraftReport(report: DraftReport): string {
  return draftReportLines(report).join('\n');
}
