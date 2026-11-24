// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from '../../core/src/log.ts';

// Every test process runs this first, before anything records an event.
export function setup() {
  delete process.env.CLAUDE_CODE_SESSION_ID; // in-process record() would stamp the outer session's id
  delete process.env.CLAUDE_CODE_HOST_SESSION_ID; // and its desktop session's
  delete process.env.FACTORY_CLAIM; // an outer harness's claim token would pass the claim checks under test
  delete process.env.CLAUDECODE; // set inside Claude Code: F project set would refuse every call as an agent's
  process.env.FACTORY_TEST = '1'; // inherited by every F the tests spawn: none may touch the real state dir
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
}
