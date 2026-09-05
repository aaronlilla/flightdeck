import type { JSX } from 'react';
import { useState } from 'react';

import type { InboxEntry } from '../types.js';

export interface InboxCardProps {
  entry: InboxEntry;
  onAnswer: (key: string, answer: string) => Promise<void>;
}

export function InboxCard({ entry, onAnswer }: InboxCardProps): JSX.Element {
  const [freeText, setFreeText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const submit = async (answer: string): Promise<void> => {
    if (!answer.trim() || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(entry.key, answer);
      setFreeText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that answer did not go through');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="inbox-card" data-inbox-key={entry.key}>
      <p className="inbox-card__question">{entry.question}</p>
      <p className="inbox-card__runs">{entry.runs.join(', ')}</p>
      {entry.options.length > 0 ? (
        <div className="inbox-card__options">
          {entry.options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn"
              disabled={sending}
              onClick={() => void submit(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className="inbox-card__free-text">
        <input
          type="text"
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
          placeholder="Answer in your own words"
          aria-label={`answer to: ${entry.question}`}
          disabled={sending}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={sending || !freeText.trim()}
          onClick={() => void submit(freeText)}
        >
          Send
        </button>
      </div>
      {error ? <p className="inbox-card__error">{error}</p> : null}
    </div>
  );
}
