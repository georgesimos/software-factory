import {
  Badge, Button, Card, Checkbox, CloseIcon, Dialog, EmptyState, IconButton, Input, Kbd, MetricStat, MetricStrip, OutcomePill, OUTCOMES,
  ReviewMatrix, RunCard, SearchIcon, Select, SessionList, SessionsChip, Sheet, Skeleton, SourceChip, StageTrack, Table, Tabs, ThemeToggle, Timeline, Tooltip, useToast,
} from '@software-factory/design-system';
import { useState, type ReactNode } from 'react';
import { CAP, RUNS } from './fixtures/index.ts';

const byId = (id: string) => RUNS.find((r) => r.id === id)!;
const Demo = ({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) => (
  <figure className="pg-demo" data-wide={wide || undefined}><figcaption className="sf-label">{title}</figcaption><div className="pg-demo-body">{children}</div></figure>
);

export function Basics() {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState('all');
  const [checked, setChecked] = useState(true);
  return (
    <div className="pg-gallery">
      <Demo title="Button">
        <Button variant="primary" shortcut="⌘↵">Attach 3 projects</Button>
        <Button>Open PR</Button>
        <Button variant="ghost">Cancel</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
      </Demo>
      <Demo title="IconButton · Kbd">
        <IconButton label="Search" variant="secondary"><SearchIcon /></IconButton>
        <IconButton label="Close"><CloseIcon /></IconButton>
        <span className="pg-inline"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
        <span className="pg-inline"><Kbd>Esc</Kbd></span>
      </Demo>
      <Demo title="Input · Select">
        <Input icon={<SearchIcon />} placeholder="Filter runs" aria-label="Filter runs" />
        <Input aria-label="Repository" defaultValue="acme/shop#" invalid />
        <Select aria-label="Sort" defaultValue="updated"><option value="updated">Recently updated</option><option value="created">Created</option></Select>
      </Demo>
      <Demo title="Checkbox">
        <Checkbox label="acme/app" description="~/Development/acme/app · 2 worktrees" checked={checked} onChange={() => setChecked(!checked)} />
        <Checkbox label="Select all" indeterminate onChange={() => {}} />
        <Checkbox label="Attached" checked disabled onChange={() => {}} />
      </Demo>
      <Demo title="Badge">
        {(['neutral', 'run', 'ok', 'bad', 'warn', 'idle'] as const).map((t) => <Badge key={t} tone={t} dot>{t}</Badge>)}
        <Badge quiet>Archived</Badge>
      </Demo>
      <Demo title="ThemeToggle">
        <ThemeToggle />
        <span className="sf-muted">Stored in localStorage; applied before paint by themeInitScript.</span>
      </Demo>
      <Demo title="Tooltip">
        <Tooltip content="Dismissed: no outbound request uses user input."><Button size="sm">Hover or focus me</Button></Tooltip>
      </Demo>
      <Demo title="Dialog · Sheet · Toast">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button onClick={() => setSheet(true)}>Open sheet</Button>
        <Button onClick={() => toast({ title: 'acme/app attached', description: '5 PRs · 3 sessions imported', tone: 'ok', action: { label: 'View', onClick: () => {} } })}>Toast</Button>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Escalate to a human?" description="The run stops looping and the PR is left open for review."
          footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => setDialog(false)}>Escalate</Button></>}>
          <p className="sf-muted">acme/shop#44 · touches lib/auth/github.ts and package.json.</p>
        </Dialog>
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Sheet" description="Run details open in this side panel.">
          <StageTrack run={byId('acme/shop#43')} />
        </Sheet>
      </Demo>
      <Demo title="Tabs" wide>
        <Tabs label="Project" value={tab} onChange={setTab} items={[{ id: 'all', label: 'All', count: RUNS.length }, { id: 'acme/shop', prefix: 'acme/', label: 'shop' }, { id: 'acme/app', prefix: 'acme/', label: 'app' }]}>
          <p className="sf-muted" style={{ marginTop: 12 }}>Showing {tab === 'all' ? 'all projects' : tab}.</p>
        </Tabs>
      </Demo>
      <Demo title="Table" wide>
        <Table>
          <thead><tr><th>Project</th><th className="sf-num">Runs</th><th className="sf-num">Merged</th><th>Last sync</th></tr></thead>
          <tbody>
            <tr><td className="sf-mono">acme/shop</td><td className="sf-num">9</td><td className="sf-num">1</td><td>3m ago</td></tr>
            <tr><td className="sf-mono">acme/app</td><td className="sf-num">6</td><td className="sf-num">0</td><td>just now</td></tr>
          </tbody>
        </Table>
      </Demo>
      <Demo title="Card · Skeleton">
        <Card style={{ width: '100%' }}><div className="sf-label">Card</div><p style={{ margin: '8px 0 0' }}>Hairline border, 6px radius, no shadow.</p></Card>
        <div style={{ width: '100%' }} aria-busy="true"><Skeleton width="60%" /><Skeleton width="90%" height={10} style={{ marginTop: 8 }} /></div>
      </Demo>
      <Demo title="EmptyState" wide>
        <EmptyState title="No runs yet" compact action={<Button variant="primary">Attach projects</Button>}>
          Start one with <code>/software-factory &lt;issue&gt;</code> or attach a repo to import work in flight.
        </EmptyState>
      </Demo>
    </div>
  );
}

export function FactoryParts() {
  return (
    <div className="pg-gallery">
      <Demo title="OutcomePill">
        {OUTCOMES.map((o) => <OutcomePill key={o} outcome={o} />)}
        <OutcomePill outcome="merged" reverted />
      </Demo>
      <Demo title="SourceChip">
        {['factory', 'claude-code', 'codex', 'claude-code+codex', 'human', 'none'].map((s) => <SourceChip key={s} source={s} />)}
        <SourceChip source="codex" prefix="Tracked" />
      </Demo>
      <Demo title="MetricStat" wide>
        <MetricStrip>
          <MetricStat label="In progress" value="3" sub="1 awaiting approval" />
          <MetricStat label="Merge rate" value="50" unit="%" sub="1 merged · 1 escalated" />
          <MetricStat label="Median cycle" value={null} sub="first event → decision" />
        </MetricStrip>
        <div className="pg-facts">
          <MetricStat size="sm" label="Cost" value="$0.75" sub="of $5.00 cap" meter={0.15} />
          <MetricStat size="sm" label="Cost" value="$6.10" sub="over cap" meter={1.22} />
        </div>
      </Demo>
      <Demo title="SessionList · SessionsChip" wide>
        <SessionList sessions={byId('acme/app:dev/wip-9').sessions ?? []} />
        <div style={{ marginTop: 12 }}><SessionsChip sessions={byId('acme/app:dev/wip-9').sessions ?? []} /></div>
      </Demo>
      <Demo title="RunCard">
        <div className="pg-cards">
          {['acme/shop#45', 'acme/app#20', 'acme/shop#43', 'acme/app:dev/wip-9'].map((id) => <RunCard key={id} run={byId(id)} cap={CAP} showRepo onSelect={() => {}} />)}
        </div>
      </Demo>
      <Demo title="StageTrack (loop-backs)" wide><StageTrack run={byId('acme/shop#43')} /></Demo>
      <Demo title="ReviewMatrix (dismissed struck through)" wide><ReviewMatrix run={byId('acme/shop#43')} /></Demo>
      <Demo title="Timeline" wide><Timeline events={(byId('acme/shop#42').events ?? [])} /></Demo>
    </div>
  );
}
