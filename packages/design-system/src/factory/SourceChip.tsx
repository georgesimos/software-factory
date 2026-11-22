import { Badge } from '../components/Badge.tsx';
import type { Source } from './model.ts';

export const SOURCE_LABEL: Record<string, string> = { factory: 'Factory', 'claude-code': 'Claude Code', codex: 'Codex', human: 'Human', none: 'No session' };
/** Shape, not colour, tells sources apart: the palette stays monochrome. */
const GLYPH: Record<string, string> = { factory: '◆', 'claude-code': '●', codex: '■', human: '▲', none: '○' };

export const sourceLabel = (s: Source) => s.split('+').map((x) => SOURCE_LABEL[x] ?? x).join(' + ');

/** Where a run's work came from. Imported runs pass `prefix="Tracked"`. Unknown sources render as their raw name. */
export function SourceChip({ source = 'factory', prefix }: { source?: Source; prefix?: string }) {
  const parts = source.split('+');
  return (
    <Badge quiet={source !== 'factory'} tone={source === 'factory' ? 'run' : 'neutral'} className="sf-source" data-source={source}>
      <span className="sf-source-glyphs" aria-hidden="true">{parts.map((p) => <i key={p}>{GLYPH[p] ?? '◇'}</i>)}</span>
      {prefix ? `${prefix} · ` : ''}{sourceLabel(source)}
    </Badge>
  );
}
