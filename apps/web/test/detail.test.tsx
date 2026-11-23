import type { Run } from '@software-factory/design-system';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunDetail } from '../src/RunDetail.tsx';

const decision = (r: Partial<Run>) => {
  render(<RunDetail run={{ id: 'acme/app#1', title: 'One', stage: 'approve', ...r }} cap={3} costCap={5} />);
  return screen.getByRole('heading', { name: 'Decision' }).parentElement!.textContent;
};

describe('RunDetail decision', () => {
  it('shows Closed, not Deciding, for a closed run with a decision', () => {
    expect(decision({ outcome: 'closed', decision: { reasons: ['Issue closed upstream.'] } } as Partial<Run>)).toMatch(/^DecisionClosedIssue closed upstream\.$/i);
  });
  it('escalated without a decision record', () => {
    expect(decision({ outcome: 'escalated' })).toMatch(/Escalated to a human/);
  });
  it('closed without a decision record', () => {
    expect(decision({ outcome: 'closed' })).toMatch(/Closed/);
  });
  it('shows Deciding only while in progress, and keeps repeated reasons', () => {
    expect(decision({ outcome: 'in-progress', decision: { reasons: ['same', 'same'] } } as Partial<Run>)).toMatch(/Deciding.*samesame/);
  });
  it('says "several" for a split with no children listed', () => {
    expect(decision({ outcome: 'split', children: [] })).toMatch(/Split into several runs/);
  });
});
