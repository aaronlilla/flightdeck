import { describe, expect, it } from 'vitest';
import { settingsPageHtml } from '../settings-page';

describe('settingsPageHtml', () => {
  it('seeds the form with the given entries', () => {
    const html = settingsPageHtml({ FORGE_QUEUE: '1', FORGE_PORT: '4130' });
    expect(html).toContain('FORGE_QUEUE');
    expect(html).toContain('4130');
  });

  it('carries an add row and a save action', () => {
    const html = settingsPageHtml({});
    expect(html).toContain('id="add-row"');
    expect(html).toContain('id="save"');
    expect(html).toContain('window.settingsBridge.save');
  });

  it('escapes a value that could close the embedded <script> tag early', () => {
    const html = settingsPageHtml({ KEY: '</script><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('&lt;/script&gt;');
  });
});
