import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitVersion, runtimeVersion } from '../src/version.ts';

// A one-commit checkout; returns the commit's short SHA.
function checkout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'factory-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'file'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { root, git, sha: git('rev-parse', '--short', 'HEAD') };
}

test('a checkout is versioned by the tag on its commit, else by its short commit SHA', t => {
  const { root, git, sha } = checkout(t);
  assert.equal(gitVersion(root), sha);
  git('tag', 'v1.2.3');
  assert.equal(gitVersion(root), 'v1.2.3');
  writeFileSync(join(root, 'file'), 'two\n');
  git('commit', '-qam', 'two');
  assert.equal(gitVersion(root), git('rev-parse', '--short', 'HEAD'), 'a tag on an earlier commit does not name this one');
});

test('an installed runtime reports the version its installer recorded over its Git state', t => {
  const { root } = checkout(t);
  writeFileSync(join(root, 'VERSION'), 'v9.9.9\n');
  assert.equal(runtimeVersion(root), 'v9.9.9');
});
