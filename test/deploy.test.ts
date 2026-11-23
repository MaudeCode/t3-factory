import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The deployer against a local remote whose installers record the version they install, with npm stubbed out.
test('the deployer installs the newest release tag once and ignores prereleases', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'), bin = join(root, 'bin'), log = join(root, 'installed'), tagFile = join(root, 'state/tag');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LOG: log, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: remote, env });
  mkdirSync(join(remote, 'scripts'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'npm'), 0o755);
  for (const name of ['install', 'install-web'])
    writeFileSync(join(remote, `scripts/${name}.ts`), `import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync(process.env.DEPLOY_LOG!, '${name} ' + readFileSync('VERSION', 'utf8'));\n`);
  git('init', '-q', '-b', 'main');
  const release = (version: string) => {
    writeFileSync(join(remote, 'VERSION'), `${version}\n`);
    git('add', '.'); git('commit', '-qm', version); git('tag', `v${version}`);
  };
  const deploy = () => execFileSync(process.execPath, [join(import.meta.dirname, '../scripts/deploy.ts'), remote, join(root, 'source'), tagFile], { env, stdio: 'pipe' });
  const installed = () => readFileSync(log, 'utf8');

  release('0.1.0'); release('0.2.0'); release('0.3.0-rc.1');
  deploy();
  assert.equal(installed(), 'install 0.2.0\ninstall-web 0.2.0\n');
  assert.equal(readFileSync(tagFile, 'utf8'), 'v0.2.0\n');

  deploy();
  assert.equal(installed(), 'install 0.2.0\ninstall-web 0.2.0\n', 'a deployed tag is not installed again');

  release('0.10.0');
  deploy();
  assert.equal(installed(), 'install 0.2.0\ninstall-web 0.2.0\ninstall 0.10.0\ninstall-web 0.10.0\n');
});
