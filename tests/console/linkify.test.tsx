// @vitest-environment jsdom
/**
 * `Linkify` (2026-09-08, Aaron: "when there's jira tickets mentioned or PRs mentioned
 * anywhere in the application, they need to be hyperlinked"): a Jira key, a PR mention
 * and a bare https URL inside a text node each become a link.
 */
import type { JSX, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Linkify } from '../../src/console/components/Linkify.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { State } from '../../src/console/store.js';

function withLinks(links: State['links'], children: ReactNode): JSX.Element {
  const state = { ...initialState(), links };
  return <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>{children}</StoreContext.Provider>;
}

describe('Linkify', () => {
  it('links a bare ticket key to the jira site', () => {
    render(withLinks({ jiraSite: 'https://acme.atlassian.net', defaultRepo: null }, <Linkify text="closes BBZ-123 today" />));
    const link = screen.getByText('BBZ-123');
    expect(link.closest('a')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/BBZ-123');
    expect(link.closest('a')).toHaveAttribute('target', '_blank');
    expect(link.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves a ticket key as plain text when no jira site is known', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="closes BBZ-123 today" />));
    const el = screen.getByText(/BBZ-123/);
    expect(el.closest('a')).toBeNull();
  });

  it('links "PR #123" to the given repo', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="see PR #118 for detail" repo="acme/widgets" />));
    const link = screen.getByText('PR #118');
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/118');
  });

  it('links "draft PR #123"', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="Opened draft PR #44: fix the fee cap" repo="acme/widgets" />));
    const link = screen.getByText('draft PR #44');
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/44');
  });

  it('links a bare "#123" when preceded by "pull request"', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="pull request #77 is ready" repo="acme/widgets" />));
    const link = screen.getByText('#77');
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/77');
  });

  it('does not link a bare "#123" with no preceding PR/pull request word', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="ticket #77 is unrelated" repo="acme/widgets" />));
    const el = screen.getByText(/#77/);
    expect(el.closest('a')).toBeNull();
  });

  it('falls back to defaultRepo when the text has no repo of its own', () => {
    render(withLinks({ jiraSite: null, defaultRepo: 'acme/default' }, <Linkify text="PR #9 landed" />));
    const link = screen.getByText('PR #9');
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/acme/default/pull/9');
  });

  it('stays plain text when both repo and defaultRepo are null', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="PR #9 landed" />));
    const el = screen.getByText(/PR #9/);
    expect(el.closest('a')).toBeNull();
  });

  it('links a full https url', () => {
    render(withLinks({ jiraSite: null, defaultRepo: null }, <Linkify text="see https://example.com/x for detail" />));
    const link = screen.getByText('https://example.com/x');
    expect(link.closest('a')).toHaveAttribute('href', 'https://example.com/x');
  });

  it('stops propagation on click, so a link inside a clickable tile does not also open the tile', async () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        {withLinks({ jiraSite: 'https://acme.atlassian.net', defaultRepo: null }, <Linkify text="BBZ-123" />)}
      </div>,
    );
    await userEvent.click(screen.getByText('BBZ-123'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders multiple links in one text and keeps the surrounding words', () => {
    render(withLinks(
      { jiraSite: 'https://acme.atlassian.net', defaultRepo: null },
      <Linkify text="BBZ-1 and BBZ-2 both need review" />,
    ));
    expect(screen.getByText('BBZ-1').closest('a')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/BBZ-1');
    expect(screen.getByText('BBZ-2').closest('a')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/BBZ-2');
    expect(screen.getByText(/both need review/)).toBeInTheDocument();
  });
});
