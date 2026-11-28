import type { Run } from '@software-factory/design-system';
import { cleanup, render, screen } from '@testing-library/react';
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
  it('says Merging or Escalating for an in-progress run with a decision, and keeps repeated reasons', () => {
    expect(decision({ outcome: 'in-progress', decision: { action: 'merge', reasons: ['same', 'same'] } })).toMatch(/Merging.*samesame/);
    cleanup();
    expect(decision({ outcome: 'in-progress', decision: { action: 'escalate', reasons: ['x'] } })).toMatch(/Escalating/);
  });

  it('shows intake rejection reasons given as a reasons array', () => {
    expect(decision({ outcome: 'rejected', events: [{ stage: 'intake', status: 'rejected', reasons: ['Out of scope.', 'Duplicate of #3.'] }] }))
      .toMatch(/Rejected at intakeOut of scope\.Duplicate of #3\./);
  });

  it('awaiting approval: the reasons, then where the human approves, and no button (local-first 5c)', () => {
    expect(decision({ outcome: 'awaiting-approval', events: [{ stage: 'spec', status: 'awaiting-approval', reasons: ['Untrusted author.'] }] }))
      .toMatch(/Spec awaiting human approvalUntrusted author\.A local item: approve from the app menu \(Run → Approve…\) or run F approve acme\/app#1\. A GitHub issue: comment \/factory approve on it\.$/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('takes split reasons from the split event', () => {
    expect(decision({ outcome: 'split', children: ['a/b#2', 'a/b#3'], events: [{ stage: 'intake', status: 'split', reasons: ['Two features.'] }] }))
      .toMatch(/Split into 2 runsTwo features\./);
  });

  it('links the revert PR and skips an empty reason', () => {
    expect(decision({ outcome: 'merged', reverted: { pr: 'https://github.com/a/b/pull/9' } })).toMatch(/Reverted · revert PR$/);
    expect(screen.getByRole('link', { name: 'revert PR' }).getAttribute('href')).toBe('https://github.com/a/b/pull/9');
  });
  it('says "several" for a split with no children listed', () => {
    expect(decision({ outcome: 'split', children: [] })).toMatch(/Split into several runs/);
  });
});

describe('RunDetail cost', () => {
  const facts = (r: Partial<Run> & { burn?: unknown }, costCap = 5) => {
    render(<RunDetail run={{ id: 'acme/app#1', stage: 'build', ...r } as Run} cap={3} costCap={costCap} />);
    return screen.getByRole('heading', { name: 'Run' }).parentElement!.textContent;
  };

  it('prefers measured burn over reported cost and tokens', () => {
    const t = facts({ costUsd: 0.9, tokens: 1000, burn: { total: { costUsd: 4.8, tokens: 2_400_000 } } });
    expect(t).toMatch(/\$4\.80of \$5\.00 cap/);
    expect(t).not.toMatch(/\$0\.90/);
    expect(t).toMatch(/2\.4M/);
  });

  it('falls back to reported numbers, and drops the meter when the cap is 0', () => {
    const t = facts({ costUsd: 0.9 }, 0);
    expect(t).toMatch(/\$0\.90/);
    expect(t).not.toMatch(/cap/);
  });
});

describe('RunDetail route (pipelines §7.4)', () => {
  const route = { pipeline: 'ui', name: 'UI first', set: 0, text: 'files web/**', facts: { labels: ['hotfix'], files: ['web/a.tsx', 'web/b.css'], diffLines: 12 }, off: [], caps: { loops: 1, budgetUsd: 2 }, local: false,
    picks: [{ pipeline: 'ui', set: 0, iteration: 1 }, { pipeline: 'default', set: null, iteration: 2 }, { pipeline: 'ui', set: 0, iteration: 3 }] };
  it('names the pipeline and the set, what the pick read, every pick when it moved, and the meet\'s caps', () => {
    render(<RunDetail run={{ id: 'acme/app#2', title: 'Two', stage: 'review', iteration: 1, route } as Run} cap={3} costCap={5} />);
    expect(screen.getByText(/^Pipeline/, { selector: 'p' }).textContent).toBe('Pipeline UI first · set 1: files web/** · read label hotfix · 2 files · 12 lines · picked ui → default → ui: it keeps the strictest, nothing off');
    expect(screen.getByText('1 / 1')).toBeInTheDocument(); // run.loops: the meet's 1, not the project's 3
    cleanup();
    render(<RunDetail run={{ id: 'acme/app#3', title: 'Three', stage: 'review', route: { ...route, pipeline: 'default', name: null, set: null, text: null, facts: { labels: [], files: ['a.ts'], diffLines: null }, picks: [route.picks[1]] } } as Run} cap={3} costCap={5} />);
    expect(screen.getByText(/^Default pipeline/).textContent).toBe('Default pipeline · read no labels · 1 file');
    cleanup();
    render(<RunDetail run={{ id: 'acme/app#4', title: 'Four', stage: 'review', route: { ...route, pipeline: 'default', name: null, set: null, text: null, facts: { labels: [], files: Array(200).fill('a.ts'), fileCount: 201, truncated: true, diffLines: null }, picks: [route.picks[1]] } } as Run} cap={3} costCap={5} />);
    expect(screen.getByText(/^Default pipeline/).textContent).toBe('Default pipeline · read no labels · 201 files (200 recorded)'); // a cut-down list never reads as complete
  });
});
