// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from '../../core/src/log.ts';

// Every test process runs this first, before anything records an event.
export function setup() {
  delete process.env.CLAUDE_CODE_SESSION_ID; // in-process record() would stamp the outer session's id
  process.env.FACTORY_TEST = '1'; // inherited by every F the tests spawn: none may touch the real state dir
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
}
