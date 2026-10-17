import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native manual submissions drain in order through the real model with a deferred command fixture', { skip: process.platform !== 'darwin', timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-native-'));
  const exec = promisify(execFile);
  try {
    // Keep the real icon/render helpers; only replace the app entry point with the command fixture.
    const app = join(dir, 'App.swift');
    writeFileSync(app, readFileSync('macos/T3FactoryApp.swift', 'utf8').replace('@main enum T3FactoryMenuApp', 'enum T3FactoryMenuApp'));
    const sources = readdirSync('macos').filter(f => f.endsWith('.swift') && f !== 'T3FactoryApp.swift').map(f => resolve('macos', f));
    const binary = join(dir, 'fixture');
    await exec('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources, app, resolve('test/fixtures/native-queue.swift'), '-o', binary]);
    const result = await exec(binary, [dir]);
    assert.match(result.stdout, /Native queue passed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
