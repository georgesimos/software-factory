import { Badge } from '../components/Badge.tsx';
import { OUTCOME_LABEL, OUTCOME_TONE, type Outcome } from './model.ts';

/** A run's outcome. `reverted` (a flag on merged runs) wins over the outcome. */
export function OutcomePill({ outcome = 'in-progress', reverted, live }: { outcome?: Outcome; reverted?: boolean; live?: boolean }) {
  const k = reverted ? 'reverted' : OUTCOME_TONE[outcome] ? outcome : 'in-progress';
  return <Badge tone={OUTCOME_TONE[k]} dot live={live && k === 'in-progress'}>{OUTCOME_LABEL[k]}</Badge>;
}
