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
    fs.writeFileSync(path.join(d, 'config'), `[core]\n\tbare = false\n${url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`);
  };
  clone('work/shop', 'git@github.com:acme/shop.git', 2);
  clone('old/shop-copy', 'https://github.com/acme/shop');
  clone('work/site', 'https://github.com/acme/site.git/');
  clone('work/gitlab-thing', 'git@gitlab.com:acme/thing.git');
  clone('work/app/node_modules/dep', 'git@github.com:evil/dep.git');
  clone('.hidden/secret', 'git@github.com:acme/secret.git');
  clone('work/umbrella', 'git@github.com:acme/umbrella.git');
  clone('work/umbrella/nested', 'git@github.com:acme/nested.git'); // a clone inside another repo
  clone('work/private', 'https://pat:s3cret@git.example.com/team/sub/private.git'); // a self-hosted origin with a credential
  clone('work/notes', ''); // no remote at all
  clone('old/notes', ''); // same folder name, another repository
  fs.mkdirSync(path.join(root, 'work/shop/.claude/worktrees/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work/shop/.claude/worktrees/x/.git'), 'gitdir: ../../.git/worktrees/w0');
  const found = discover([root]);
  assert.deepEqual(found.map((f) => f.repo).sort(), ['acme/nested', 'acme/shop', 'acme/site', 'acme/thing', 'acme/umbrella', 'local/notes', 'local/notes', 'team-sub/private']);
  // GitHub clones keep exactly the shape they had (no host or remote key); any other origin is a git project
  assert.deepEqual(Object.keys(found.find((f) => f.repo === 'acme/site')).sort(), ['attached', 'lastCommit', 'otherClones', 'path', 'repo', 'worktrees']);
  assert.deepEqual([found.find((f) => f.repo === 'acme/thing').host, found.find((f) => f.repo === 'acme/thing').remote], ['git', 'git@gitlab.com:acme/thing.git']);
  const priv = found.find((f) => f.repo === 'team-sub/private');
  assert.equal(priv.remote, 'https://git.example.com/team/sub/private.git'); // the credential is never stored or shown
  assert.ok(!JSON.stringify(found).includes('s3cret'));
  const notes = found.filter((f) => f.repo === 'local/notes');
  assert.deepEqual(notes.map((f) => [f.host, f.remote, f.otherClones.length]), [['git', undefined, 0], ['git', undefined, 0]]); // two folders, two repos
  const shop = found.find((f) => f.repo === 'acme/shop');
  assert.equal(shop.otherClones.length, 1);
  assert.equal(found.find((f) => f.repo === 'acme/site').attached, false);
}

setup();
test('discover: local clones and their worktrees', discoverTest);
