// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover } from '../../core/src/sync.ts';
import { test } from 'node:test';
import { setup } from './setup.mjs';

export function discoverTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-discover-'));
  const clone = (rel, url, worktrees = 0) => {
    const d = path.join(root, rel, '.git');
    fs.mkdirSync(path.join(d, 'worktrees'), { recursive: true });
    for (let i = 0; i < worktrees; i++) fs.mkdirSync(path.join(d, 'worktrees', `w${i}`));
    fs.writeFileSync(path.join(d, 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  };
  clone('work/shop', 'git@github.com:acme/shop.git', 2);
  clone('old/shop-copy', 'https://github.com/acme/shop');
  clone('work/site', 'https://github.com/acme/site.git/');
  clone('work/gitlab-thing', 'git@gitlab.com:acme/thing.git');
  clone('work/app/node_modules/dep', 'git@github.com:evil/dep.git');
  clone('.hidden/secret', 'git@github.com:acme/secret.git');
  clone('work/umbrella', 'git@github.com:acme/umbrella.git');
  clone('work/umbrella/nested', 'git@github.com:acme/nested.git'); // a clone inside another repo
  fs.mkdirSync(path.join(root, 'work/shop/.claude/worktrees/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work/shop/.claude/worktrees/x/.git'), 'gitdir: ../../.git/worktrees/w0');
  const found = discover([root]);
  assert.deepEqual(found.map((f) => f.repo).sort(), ['acme/nested', 'acme/shop', 'acme/site', 'acme/umbrella']);
  const shop = found.find((f) => f.repo === 'acme/shop');
  assert.equal(shop.otherClones.length, 1);
  assert.equal(found.find((f) => f.repo === 'acme/site').attached, false);
}

setup();
test('discover: local clones and their worktrees', discoverTest);
