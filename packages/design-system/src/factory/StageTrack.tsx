import type { CSSProperties } from 'react';
import { Badge } from '../components/Badge.tsx';
import { STAGES, isDone, runnerLabel, stageOf, stageState, type Loopback, type Run } from './model.ts';
import { breakable } from './breakable.tsx';

const SR: Record<string, string> = { active: 'in progress', skipped: 'skipped', pending: 'not reached', done: 'done', failed: 'failed', warn: 'needs attention', idle: 'closed' };

/** The six pipeline stages with the current one ringed, plus loop-back arcs from the gate to spec/build. */
export function StageTrack({ run }: { run: Run }) {
  const cur = STAGES.indexOf(stageOf(run)), live = !isDone(run);
  const routes: Partial<Record<'spec' | 'build', Loopback[]>> = {};
  for (const l of run.loopbacks ?? []) if (l.route === 'spec' || l.route === 'build') (routes[l.route] ??= []).push(l);
  const order = (['build', 'spec'] as const).filter((k) => routes[k]);
  const gate = STAGES.indexOf('gate');
  return (
    <div className="sf-track-wrap">
      <ol className="sf-track" aria-label="Pipeline">
        {STAGES.map((s, i) => {
          const { state, sub } = stageState(run, s);
          // review: per axis, in the matrix; gate: the verifier
          const used = s === 'review' ? '' : (s === 'gate' ? run.burn?.byAxis?.verifier : run.burn?.byStage?.[s])?.used ?? '';
          const rn = runnerLabel(run.runners?.[s], true, s === 'gate' ? 'Verifier run by' : undefined, used);
          return (
            <li key={s} className="sf-st" data-state={state} data-current={i === cur || undefined} data-stale={(live && i > cur && state !== 'pending') || undefined}
              aria-current={i === cur ? 'step' : undefined}>
              <span className="sf-st-n" aria-hidden="true" />
              <div className="sf-st-nm">{s}<span className="sf-sr-only">: {SR[state]}</span></div>
              <div className="sf-st-sb">{sub || ' '}</div>
              {rn ? <Badge quiet className="sf-rn" title={rn.title}>{breakable(rn.text)}</Badge> : null}
            </li>
          );
        })}
      </ol>
      {order.length ? (
        <div className="sf-arcs">
          {order.map((k, row) => {
            const from = STAGES.indexOf(k), ls = routes[k]!;
            const iters = ls.map((l) => l.iteration ?? '?').join(', ');
            return (
              <div key={k} className="sf-arc" title={ls.map((l) => `iter ${l.iteration ?? '?'}: ${(l.reasons ?? []).join('; ')}`).join('\n')}
                style={{ gridColumn: `${from + 1} / ${gate + 2}`, '--span': gate - from + 1, '--h': `${12 + row * 30}px` } as CSSProperties}>
                <span>↺ {k} · iter {iters}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
