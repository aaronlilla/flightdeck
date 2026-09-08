import { describe, expect, it } from 'vitest';

import { settingsPageHtml } from '../settings-page';
import { statusPageHtml } from '../status-page';

// Both windows are HTML strings loaded through a data URL, so the lockup has to
// travel inside the string as an image the page can decode without a server.
describe('status and settings pages carry the Flightdeck lockup', () => {
  it.each([
    ['status', statusPageHtml()],
    ['settings', settingsPageHtml()],
  ])('%s page has the brand image above its content', (_name, html) => {
    const match = html.match(/<img id="brand" src="([^"]+)" alt="Flightdeck">/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toBe('');
    // Both pages lay #wrap out as a flex column, which stretches children to the full
    // width by default and would distort the image; the rule has to opt the brand out.
    expect(html).toMatch(/#brand \{[^}]*align-self: flex-start/);
    expect(html.indexOf('<img id="brand"')).toBeLessThan(html.indexOf('id="message"') > -1 ? html.indexOf('id="message"') : html.indexOf('<h1>'));
  });
});
