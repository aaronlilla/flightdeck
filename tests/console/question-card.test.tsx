// @vitest-environment jsdom
/**
 * `QuestionCard` (W2): where a worker's `forge_ask` finally becomes something a
 * person can read and answer. Full question text, four or more options with the
 * recommended one first and preselected, a free-text row, one Send button. A
 * question with no text (an old, empty-ask inbox row) shows no answer box at all.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { render } from './helpers/with-store.js';
import { QuestionCard } from '../../src/console/components/QuestionCard.js';

const OPTIONS = ['Use dev', 'Use staging', 'Use prod', 'Ask Joe first'];

describe('QuestionCard', () => {
  it('shows the question text in full', () => {
    render(
      <QuestionCard
        askKey="k1" question="Which environment should the migration target?" from="queue-BBZ-1"
        askedAt={Date.now()} options={OPTIONS} recommended={1} onCommand={() => {}}
      />,
    );
    expect(screen.getByText('Which environment should the migration target?')).toBeTruthy();
  });

  it('renders the recommended option first, labelled and preselected', () => {
    render(
      <QuestionCard
        askKey="k1" question="Which environment?" from="queue-BBZ-1" askedAt={Date.now()}
        options={OPTIONS} recommended={1} onCommand={() => {}}
      />,
    );
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    // First option row is the recommended one ('Use staging'), and it's checked.
    expect(radios[0]!.checked).toBe(true);
    expect(screen.getByTestId('question-option-recommended').textContent).toContain('Use staging');
    expect(screen.getByTestId('question-option-recommended').textContent).toContain('Recommended');
  });

  it('Send posts answer <key> <option text> for the preselected option', async () => {
    const onCommand = vi.fn();
    render(
      <QuestionCard
        askKey="k1" question="Which environment?" from="queue-BBZ-1" askedAt={Date.now()}
        options={OPTIONS} recommended={1} onCommand={onCommand}
      />,
    );
    await userEvent.click(screen.getByTestId('question-send'));
    expect(onCommand).toHaveBeenCalledWith('answer k1 Use staging');
  });

  it('Send posts the typed free text when the free-text row is chosen', async () => {
    const onCommand = vi.fn();
    render(
      <QuestionCard
        askKey="k1" question="Which environment?" from="queue-BBZ-1" askedAt={Date.now()}
        options={OPTIONS} recommended={1} onCommand={onCommand}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText('or type an answer'), 'None of these, wait for Joe');
    await userEvent.click(screen.getByTestId('question-send'));
    expect(onCommand).toHaveBeenCalledWith('answer k1 None of these, wait for Joe');
  });

  it('renders no-question copy with Dismiss and Resume, and no Send, when the text is empty', () => {
    render(
      <QuestionCard
        askKey="k2" question="" from="queue-BBZ-2" askedAt={Date.now()}
        options={[]} recommended={null} laneId="queue-BBZ-2" onCommand={() => {}}
      />,
    );
    expect(screen.getByText('This run asked for something but sent no question')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
    expect(screen.getByText('Resume')).toBeTruthy();
    expect(screen.queryByTestId('question-send')).toBeNull();
  });

  it('disables Send once clicked, in the pending state', async () => {
    const onCommand = vi.fn();
    render(
      <QuestionCard
        askKey="k1" question="Which environment?" from="queue-BBZ-1" askedAt={Date.now()}
        options={OPTIONS} recommended={1} onCommand={onCommand}
      />,
    );
    const send = screen.getByTestId('question-send');
    await userEvent.click(send);
    expect(onCommand).toHaveBeenCalledTimes(1);
    await userEvent.click(send);
    // A second click while pending never sends a second command.
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('renders the already-answered line instead of any control once answered', () => {
    render(
      <QuestionCard
        askKey="k1" question="Which environment?" from="queue-BBZ-1" askedAt={Date.now()}
        options={OPTIONS} recommended={1} answer="Use staging" onCommand={() => {}}
      />,
    );
    expect(screen.getByText('answered: Use staging')).toBeTruthy();
    expect(screen.queryByTestId('question-send')).toBeNull();
  });
});
