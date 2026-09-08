import { useContext } from 'react';
import type { JSX, ReactNode } from 'react';
import { Fragment } from 'react';

import { StoreContext } from '../store.js';

/**
 * `<Linkify text repo />` (2026-09-08, Aaron: "when there's jira tickets mentioned or
 * PRs mentioned anywhere in the application, they need to be hyperlinked"). Renders
 * `text` with every Jira key (`BBZ-123`), every PR mention (`PR #123`, `draft PR #123`,
 * a bare `#123` when the word `PR` or `pull request` names it earlier in the text) and
 * every bare `https://` url turned into a link. `jiraSite` and `defaultRepo` come off
 * the store (`GET /lanes`'s own `links` field); `repo` is the lane or message's own
 * repo, when the caller has one, and wins over `defaultRepo`. A key or a PR mention
 * with nothing to link to (`jiraSite` unset, no repo of any kind) stays plain text --
 * never a broken link.
 */
const TICKET_RE = /\b[A-Z]{2,6}-\d+\b/g;
const PR_RE = /\b((?:draft\s+)?PR\s*#\d+|pull request\s*#\d+|#\d+)\b/gi;
const URL_RE = /\bhttps:\/\/[^\s<>"')]+/g;

interface Token {
  start: number;
  end: number;
  render: (key: number) => ReactNode;
}

function jiraUrl(site: string, key: string): string {
  return `${site.replace(/\/+$/, '')}/browse/${key}`;
}

function prNumberFrom(match: string): number | null {
  const digits = /\d+/.exec(match);
  return digits ? Number(digits[0]) : null;
}

function LinkTo({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="m"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

export function Linkify({ text, repo }: { text: string; repo?: string | null }): JSX.Element {
  // Outside the store (a card rendered on its own, a unit test) there is no Jira site
  // and no default repo to link against, so the text simply stays plain.
  const ctx = useContext(StoreContext);
  const { jiraSite, defaultRepo } = ctx?.state.links ?? { jiraSite: null, defaultRepo: null };
  const effectiveRepo = repo ?? defaultRepo;

  const tokens: Token[] = [];

  if (jiraSite) {
    for (const match of text.matchAll(TICKET_RE)) {
      const key = match[0];
      const start = match.index ?? 0;
      tokens.push({
        start, end: start + key.length,
        render: (k) => <LinkTo key={k} href={jiraUrl(jiraSite, key)}>{key}</LinkTo>,
      });
    }
  }

  if (effectiveRepo) {
    // "pull request #77" links only the "#77" portion (matching the PR-word form the
    // brief spells out), never the whole "pull request" phrase.
    for (const match of text.matchAll(PR_RE)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const no = prNumberFrom(raw);
      if (no === null) continue;
      const isPullRequestWord = /^pull request/i.test(raw);
      const visible = isPullRequestWord ? `#${no}` : raw;
      const offset = isPullRequestWord ? raw.length - visible.length : 0;
      tokens.push({
        start: start + offset, end: start + raw.length,
        render: (k) => <LinkTo key={k} href={`https://github.com/${effectiveRepo}/pull/${no}`}>{visible}</LinkTo>,
      });
    }
  }

  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const start = match.index ?? 0;
    tokens.push({
      start, end: start + url.length,
      render: (k) => <LinkTo key={k} href={url}>{url}</LinkTo>,
    });
  }

  // Overlapping matches (a jira key inside a url, say) resolve first-found-wins, kept
  // in text order -- sort by start, then drop any token that starts before the
  // previous one ended.
  tokens.sort((a, b) => a.start - b.start);
  const kept: Token[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) continue;
    kept.push(token);
    cursor = token.end;
  }

  if (kept.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let pos = 0;
  kept.forEach((token, index) => {
    if (token.start > pos) parts.push(<Fragment key={`t-${index}`}>{text.slice(pos, token.start)}</Fragment>);
    parts.push(token.render(index));
    pos = token.end;
  });
  if (pos < text.length) parts.push(<Fragment key="t-last">{text.slice(pos)}</Fragment>);

  return <>{parts}</>;
}
