// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io, record, runDir } from '../../core/src/log.ts';
import { approveSpec } from '../../core/src/approve.ts';

// Every test process runs this first, before anything records an event.
export function setup() {
  delete process.env.CLAUDE_CODE_SESSION_ID; // in-process record() would stamp the outer session's id
  delete process.env.CLAUDE_CODE_HOST_SESSION_ID; // and its desktop session's
  delete process.env.FACTORY_CLAIM; // an outer harness's claim token would pass the claim checks under test
  delete process.env.CLAUDECODE; // set inside Claude Code: F project set would refuse every call as an agent's
  process.env.FACTORY_TEST = '1'; // inherited by every F the tests spawn: none may touch the real state dir
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
}

/** A local item's spec put to the user, approved and passed, as the skill and F approve do: for tests of what comes after (a worktree). */
export function passSpec(run) {
  fs.mkdirSync(runDir(run), { recursive: true });
  fs.writeFileSync(path.join(runDir(run), 'spec.md'), '# Goal\n\nx\n');
  record(run, 'spec', 'awaiting-approval', { spec: 'x' });
  const gh = io.gh; io.gh = path.join(os.tmpdir(), 'no-such-gh-binary'); // who approves: the OS user here, so no test's gh stub sees a call
  try { approveSpec(run, (p) => /Type ([0-9a-f]{7}) to approve/.exec(p)[1]); } finally { io.gh = gh; }
  record(run, 'spec', 'passed');
}
