// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { JournalSheet } from '../../src/console/components/JournalSheet.js';

describe('JournalSheet', () => {
  it('falls back to "all entries" when no run is given, matching the prototype', () => {
    render(<JournalSheet rows={[]} onClose={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText('Journal · all entries')).toBeInTheDocument();
  });

  it('labels the header with the given run when one is given', () => {
    render(<JournalSheet rows={[]} run="J-40217" onClose={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText('Journal · J-40217')).toBeInTheDocument();
  });
});
