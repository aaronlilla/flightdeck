import { describe, expect, it } from 'vitest';
import { statusPageHtml } from '../status-page';

describe('statusPageHtml', () => {
  it('carries a queue banner element and wires it to the bridge\'s onQueueState', () => {
    const html = statusPageHtml();
    expect(html).toContain('id="queue-banner"');
    expect(html).toContain('window.statusBridge.onQueueState');
  });

  it('still carries the ordinary status/log/picker wiring', () => {
    const html = statusPageHtml();
    expect(html).toContain('window.statusBridge.onStatus');
    expect(html).toContain('window.statusBridge.onLog');
    expect(html).toContain('window.statusBridge.onNeedFolder');
  });
});
