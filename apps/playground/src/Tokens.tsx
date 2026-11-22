import { tokens, type Theme } from '@software-factory/design-system';

const { color, text, space, radius, shadow, motion, z, status, cssVar } = tokens;
const px = (v: string) => parseFloat(v) || 0;

function Palette({ theme }: { theme: Theme }) {
  return (
    <div data-theme={theme} className="pg-theme-pane">
      <div className="sf-label">{theme}</div>
      <div className="pg-swatches">
        {Object.entries(color[theme]).map(([k, v]) => (
          <div key={k} className="pg-swatch">
            <span className="pg-chip" style={{ background: `var(${cssVar('color', k)})` }} />
            <code>{cssVar('color', k)}</code>
            <span className="pg-hex">{v}</span>
          </div>
        ))}
      </div>
      <div className="pg-states">
        {Object.entries(status).map(([group, states]) => (
          <div key={group}>
            <div className="sf-label">{group}</div>
            <ul className="pg-state-list">
              {Object.entries(states).map(([s, tone]) => (
                <li key={s}><span className="sf-dot" style={{ background: `var(--sf-${group}-${s})` }} /><code>--sf-{group}-{s}</code><span className="pg-hex">{tone}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Tokens() {
  return (
    <>
      <h3 className="pg-h3">Colour and state, both themes</h3>
      <div className="pg-two"><Palette theme="light" /><Palette theme="dark" /></div>

      <h3 className="pg-h3">Type scale</h3>
      <div className="pg-rows">
        {Object.entries(text).map(([k, v]) => (
          <div key={k} className="pg-row"><code>{cssVar('text', k)}</code><span className="pg-hex">{v}</span>
            <span style={{ fontSize: `var(${cssVar('text', k)})`, letterSpacing: k === 'display' ? '-0.035em' : undefined, lineHeight: 1.2 }}>{k === 'display' ? '82%' : 'Debounce product search'}</span></div>
        ))}
        <div className="pg-row"><code>.sf-label</code><span className="pg-hex">mono 11 / 0.08em</span><span className="sf-label">Median cycle</span></div>
        <div className="pg-row"><code>--sf-font-mono</code><span className="pg-hex">Geist Mono</span><span className="sf-mono" style={{ fontSize: 12 }}>acme/shop#43 · iter 2 · $0.75</span></div>
      </div>

      <h3 className="pg-h3">Spacing</h3>
      <div className="pg-rows">
        {Object.entries(space).sort((a, b) => px(a[1]) - px(b[1])).map(([k, v]) => (
          <div key={k} className="pg-row"><code>{cssVar('space', k)}</code><span className="pg-hex">{v}</span><span className="pg-bar" style={{ width: `var(${cssVar('space', k)})` }} /></div>
        ))}
      </div>

      <h3 className="pg-h3">Radii, shadows, motion, z-index</h3>
      <div className="pg-grid">
        {Object.entries(radius).map(([k, v]) => (
          <div key={k} className="pg-tile" style={{ borderRadius: `var(${cssVar('radius', k)})` }}><code>{cssVar('radius', k)}</code><span className="pg-hex">{v}</span></div>
        ))}
        {Object.keys(shadow.light).map((k) => (
          <div key={k} className="pg-tile" style={{ boxShadow: `var(${cssVar('shadow', k)})`, border: 0 }}><code>{cssVar('shadow', k)}</code></div>
        ))}
        {Object.entries(motion).map(([k, v]) => (
          <div key={k} className="pg-tile pg-motion" style={{ transitionDuration: k.startsWith('duration') ? `var(${cssVar('motion', k)})` : undefined }}><code>{cssVar('motion', k)}</code><span className="pg-hex">{v}</span></div>
        ))}
        {Object.entries(z).map(([k, v]) => (
          <div key={k} className="pg-tile"><code>{cssVar('z', k)}</code><span className="pg-hex">{v}</span></div>
        ))}
      </div>
    </>
  );
}
