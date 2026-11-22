#!/usr/bin/env node
// The F entry, kept at this path because SKILL.md and every session call it. All logic lives in ../core, ../server
// and ../cli (docs/plans/split.md); the self-test is test/*.test.mjs. Never hand-edit events.jsonl: every change goes through F.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli/src/main.ts';
export * from '../core/src/index.ts';
export { page, render, runsData, same, ui, uiHandle } from '../server/src/server.ts';
export { main };

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv.slice(2));
