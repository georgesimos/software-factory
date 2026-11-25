import { PipelineGraph, PipelineList } from '@software-factory/design-system';
import { useState } from 'react';
import { PIPELINES, PLAN } from './fixtures/pipelines.ts';

/** acme/shop's sample pipelines, first match first and the default last, drawn by the same graph the dashboard uses. */
export function Pipelines() {
  const [id, setId] = useState(PIPELINES[0]!.id);
  const p = PIPELINES.find((x) => x.id === id)!;
  return (
    <div className="sf-pl-cols pg-pipelines">
      <PipelineList items={PIPELINES} current={id} onPick={setId} />
      <PipelineGraph name={`acme/shop · ${p.name}`} pipeline={p.pipeline} plan={PLAN} cap={p.cap} costCap={p.costCap} />
    </div>
  );
}
