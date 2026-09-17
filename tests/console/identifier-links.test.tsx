// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuestionCard } from '../../src/console/components/QuestionCard.js';
import { render } from './helpers/with-store.js';
import { withLinks } from './helpers/with-links.js';

/**
 * An identifier a person reads is a link they can follow and hover.
 *
 * The escape, found on 2026-09-12: `Linkify` was written on 2026-09-08 for Aaron ("when
 * there's jira tickets mentioned or PRs mentioned anywhere in the application, they need
 * to be hyperlinked"), the server shipped the `links` field it needs and the store held
 * it — and no component ever rendered it. The supply chain was complete except the last
 * wire, `Linkify`'s own tests were green throughout, and the feature was never on screen.
 *
 * These assert the rendered output of the real components, not that a file mentions the
 * linker somewhere. A source scan passed with the strip's own heading unwired, because
 * the same file still rendered a link elsewhere.
 */

const LINKS = { jiraSite: 'https://jira.test', defaultRepo: 'o/r' };

function card(props: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
  render(withLinks(LINKS, (
    <QuestionCard
      head="BBZ-289" stamp="asked 2 min ago" text="Plain question with no key in it."
      options={['Yes', 'No']} onAnswer={() => undefined} freetext="inline"
      {...props}
    />
  )));
}

describe('the card every asking surface renders through', () => {
  it('links the ticket key in its heading', () => {
    card();
    const link = screen.getByText('BBZ-289').closest('a');
    expect(link, 'the heading key is not a link').toBeTruthy();
    expect(link?.getAttribute('href')).toBe('https://jira.test/browse/BBZ-289');
  });

  it('puts the heading key behind a hover, so it can say what it is', () => {
    card();
    expect(screen.getAllByTestId('whatis-anchor').length).toBeGreaterThan(0);
  });

  it('links a ticket mentioned in the question itself', () => {
    card({ head: 'Question', text: 'Does BBZ-123 need to land first?' });
    expect(screen.getByText('BBZ-123').closest('a')?.getAttribute('href'))
      .toBe('https://jira.test/browse/BBZ-123');
  });

  it('links a pull request mentioned in the question', () => {
    card({ head: 'Question', text: 'Is PR #159 the one to merge?' });
    expect(screen.getByText('PR #159').closest('a')?.getAttribute('href'))
      .toBe('https://github.com/o/r/pull/159');
  });

  it('leaves ordinary words alone', () => {
    card({ head: 'Question', text: 'Nothing here is an identifier.' });
    expect(screen.queryByRole('link')).toBeNull();
  });
});
