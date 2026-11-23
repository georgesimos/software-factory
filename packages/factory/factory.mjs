#!/usr/bin/env node
// The F entry, kept at this path because SKILL.md and every session call it. All logic lives in ../core, ../server
// and ../cli (docs/plans/split.md); the self-test is test/*.test.mjs. Never hand-edit events.jsonl: every change goes through F.
// No static import of a .ts file: Node loads those before any line here runs, so a Node without type stripping would stop
// with ERR_UNKNOWN_FILE_EXTENSION instead of the message below. Code that wants the API imports ../core/src/index.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.features?.typescript) {
    console.error(`F needs Node 24.12 or newer, which runs TypeScript files directly. This is Node ${process.version}: install a newer one from https://nodejs.org and run this again.`);
    process.exit(1);
  }
  const { main } = await import('../cli/src/main.ts');
  await main(process.argv.slice(2));
}
