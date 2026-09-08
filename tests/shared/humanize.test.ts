import { describe, expect, it } from 'vitest';

import {
  commandEcho, humanizeParkReason, receiptText, shortenShas, stripMachineIds, ticketInId,
} from '../../src/shared/humanize.js';

describe('stripMachineIds', () => {
  it('replaces a self run id with the caller label, else "this run"', () => {
    expect(stripMachineIds('S-b9d39bae548707e0 running Bash')).toBe('this run running Bash');
    expect(stripMachineIds('S-b9d39bae548707e0 started', { labelFor: () => 'health-repeat' })).toBe('health-repeat started');
  });

  it('reads the ticket key out of a chain or queue run id', () => {
    expect(stripMachineIds('jira_BBZ-226_1788543015139 parked')).toBe('BBZ-226 parked');
    expect(stripMachineIds('kill queue-BBZ-182')).toBe('kill BBZ-182');
    expect(stripMachineIds('queue-BBZ-96-2 finished')).toBe('BBZ-96 finished');
  });

  it('shortens a 40-character sha and drops bare hex keys and journal ids', () => {
    expect(stripMachineIds('checks are failure on head 88d44ec96baea849b82c8f6390e4c79e0d55647a, not green'))
      .toBe('checks are failure on head 88d44ec, not green');
    expect(stripMachineIds('answered f92af4249f6a27ae')).toBe('answered');
    expect(stripMachineIds('J-d11d7d30 answered f92af4249f6a27ae')).toBe('answered');
    expect(stripMachineIds('burn.mismatch (S-b9d39bae548707e0)')).toBe('burn.mismatch (this run)');
  });

  it('never returns an empty string', () => {
    expect(stripMachineIds('f92af4249f6a27ae')).toBe('this run');
  });

  it('leaves plain sentences and ticket keys alone', () => {
    expect(stripMachineIds('Draft PR #118 is open with checks green; waiting for your Merge.'))
      .toBe('Draft PR #118 is open with checks green; waiting for your Merge.');
    expect(ticketInId('jira_BBZ-226_1788543015139')).toBe('BBZ-226');
    expect(ticketInId('S-b9d39bae548707e0')).toBeNull();
  });
});

describe('shortenShas', () => {
  it('cuts only full shas', () => {
    expect(shortenShas('f284c653033e12549fdaa68212840987a328a824 and f284c65')).toBe('f284c65 and f284c65');
  });
});

describe('humanizeParkReason', () => {
  it('turns "parking on <key>: question" into an ask', () => {
    expect(humanizeParkReason('parking on 19a6c631cb7783d8: Probe: continue to the end?'))
      .toBe('Asked you: Probe: continue to the end?');
  });
  it('strips ids from any other reason', () => {
    expect(humanizeParkReason('run S-9c51e8dd3c73415c has a registry row from a process that is no longer alive'))
      .toBe('run this run has a registry row from a process that is no longer alive');
  });
});

describe('commandEcho', () => {
  const labelFor = (id: string): string | null => (id === 'queue-BBZ-182' ? 'BBZ-182' : null);

  it('says an answer without its ask key', () => {
    expect(commandEcho('answer f92af4249f6a27ae Restart the forge MCP connection')).toBe('Answered: Restart the forge MCP connection');
    expect(commandEcho('answer yes, go ahead')).toBe('Answered: yes, go ahead');
  });

  it('names a lane by its label for kill, resume, cap and why-stuck', () => {
    expect(commandEcho('kill queue-BBZ-182', { labelFor })).toBe('Kill BBZ-182.');
    expect(commandEcho('resume jira_BBZ-89_1788460932645')).toBe('Resume BBZ-89.');
    expect(commandEcho('cap S-b9d39bae548707e0 at 500k', { labelFor: () => 'health-repeat' })).toBe('Cap health-repeat at 500k tokens.');
    expect(commandEcho('why is lane queue-BBZ-96 stuck')).toBe('Why is BBZ-96 stuck?');
  });

  it('turns card tokens into words', () => {
    expect(commandEcho('confirm 3f1c2a9b-1d2e-4f3a-9b8c-7d6e5f4a3b2c')).toBe('Confirmed.');
    expect(commandEcho('dismiss abc')).toBe('Not now.');
    expect(commandEcho('run abc')).toBe('Run the plan.');
  });

  it('leaves typed commands as typed', () => {
    expect(commandEcho('status')).toBe('status');
    expect(commandEcho('pause everything')).toBe('pause everything');
    expect(commandEcho("what's stuck")).toBe("what's stuck");
  });
});

describe('receiptText', () => {
  it('names the question when the caller knows it', () => {
    expect(receiptText('answered f92af4249f6a27ae', { questionFor: () => 'Restart the forge MCP connection?' }))
      .toBe('Answered "Restart the forge MCP connection?".');
    expect(receiptText('answered f92af4249f6a27ae: yes')).toBe('Answered the question: yes');
  });
  it('strips ids from any other receipt', () => {
    expect(receiptText("restored jira_BBZ-226_1788543015139's cap")).toBe("restored BBZ-226's cap");
  });
});
