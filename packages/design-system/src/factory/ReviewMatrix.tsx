import { Table } from '../components/Table.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { Badge } from '../components/Badge.tsx';
import { burnText, costText, formatTokens, isBlocking, isDismissed, reviewFailed, runnerLabel, type Run } from './model.ts';

/** Axes × iterations verdict grid, then every finding newest-first. Dismissed findings are struck through; the reason is in a tooltip. */
export function ReviewMatrix({ run: r }: { run: Run }) {
  const axesBy = r.axes ?? {}, reviews = r.reviews ?? {};
  const iters = [...new Set([...Object.keys(axesBy), ...Object.keys(reviews)])].sort((a, b) => Number(a) - Number(b));
  if (!iters.length) return <p className="sf-muted">{r.imported ? 'Tracked run: the factory does not review it.' : 'No reviews yet.'}</p>;
  const axes = [...new Set(iters.flatMap((i) => [...(axesBy[i] ?? []), ...Object.keys(reviews[i] ?? {})]))];
  const ab = r.burn?.byAxis ?? {}, hasTok = axes.some((a) => ab[a]);
  const extra = Object.entries(ab).filter(([k]) => !axes.includes(k)); // the verifier and other non-axis reviewers
  const finds = iters.slice().reverse().flatMap((i) =>
    Object.entries(reviews[i] ?? {}).flatMap(([axis, v]) => (v.findings ?? []).map((f, j) => ({ f, axis, i, key: `${i}-${axis}-${j}` }))));
  return (
    <div className="sf-review">
      <Table aria-label="Review verdicts by axis and iteration">
        <thead><tr><th scope="col">Axis</th>{iters.map((i) => <th key={i} scope="col">Iter {i}</th>)}{hasTok ? <th scope="col">Tokens</th> : null}</tr></thead>
        <tbody>
          {axes.map((a) => (
            <tr key={a}>
              <th scope="row" className="sf-review-axis">{a}</th>
              {iters.map((i) => {
                const v = reviews[i]?.[a];
                if (!v) return (axesBy[i] ?? []).includes(a)
                  ? <td key={i} className="sf-verdict" data-v="pending">… pending</td>
                  : <td key={i} className="sf-verdict" data-v="not-reviewed"><span aria-hidden="true">·</span><span className="sf-sr-only">not reviewed</span></td>;
                const n = (v.findings ?? []).length, rn = runnerLabel(v.runner, false, undefined, ab[a]?.used ?? '');
                const chip = rn ? <Badge quiet className="sf-rn" title={rn.title}>{rn.text}</Badge> : null;
                if (!reviewFailed(v)) return <td key={i} className="sf-verdict" data-v="passed">✓ pass{n ? <span className="sf-verdict-n"> · {n}</span> : null}{chip}</td>;
                return <td key={i} className="sf-verdict" data-v="failed">✕ {(v.findings ?? []).filter(isBlocking).length || 'fail'}{chip}</td>;
              })}
              {hasTok ? <td className="sf-review-tok" title={ab[a] ? costText(ab[a]) : undefined}>{ab[a] ? formatTokens(ab[a].tokens) : '·'}</td> : null}
            </tr>
          ))}
        </tbody>
      </Table>
      {extra.length ? <p className="sf-review-burn">{extra.map(([k, c]) => `${k} ${burnText(c)}`).join('  ·  ')}</p> : null}
      {finds.length ? (
        <ul className="sf-finds" aria-label="Findings">
          {finds.map(({ f, axis, i, key }) => {
            const dis = isDismissed(f);
            const where = f.file ? f.file + (f.line != null ? `:${f.line}` : '') : null;
            const issue = f.issue || '(no description)';
            return (
              <li key={key} className="sf-find" data-dismissed={dis || undefined}>
                <span className="sf-sev" data-sev={f.severity} title={f.severity || 'severity unknown'} />
                <div className="sf-find-is">
                  {dis ? (
                    <Tooltip content={`Dismissed: ${typeof f.dismissed === 'string' && f.dismissed ? f.dismissed : 'no reason given'}`} side="bottom">
                      <span tabIndex={0} className="sf-find-issue"><s>{issue}</s></span>
                    </Tooltip>
                  ) : issue}
                </div>
                <div className="sf-find-meta">{[axis, `iter ${i}`, f.severity, where, `→ ${f.route || 'build'}`, dis ? 'dismissed' : null].filter(Boolean).join(' · ')}</div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
