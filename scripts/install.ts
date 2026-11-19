import { bootout, bootstrap, installRuntime, writeControlAgent } from './launchd.ts';
import { cpSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadEnvironment, envPath } from '../src/env.ts';
loadEnvironment();

// Deploy only application files. User configuration, credentials, and job state are preserved.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir(), app = join(home, '.local/share/t3-factory/app');
const label = process.env.T3_FACTORY_SERVICE_LABEL ?? 'local.t3-factory', domain = `gui/${process.getuid!()}`;
if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error('Invalid service label');
const plist = join(home, 'Library/LaunchAgents', `${label}.plist`);
const gh = execFileSync('/usr/bin/which', ['gh'], { encoding: 'utf8' }).trim();
const path = [dirname(gh), dirname(process.execPath), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const string = (s: string) => `<string>${escape(s)}</string>`;
const config = process.env.T3_FACTORY_CONFIG ?? join(home, '.config/t3-factory/config.jsonc');
if (!existsSync(config)) throw new Error('Create the configuration and T3 credential before installing the service');
// Checks run and the runtime is staged before the old service is unloaded, so a failed copy leaves it running.
await installRuntime(root, app, () => bootout(domain, label));
if (existsSync(envPath)) { cpSync(envPath, join(app, '.env')); chmodSync(join(app, '.env'), 0o600); }
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(join(home, 'Library/Logs'), { recursive: true });
writeControlAgent(plist, `<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[process.execPath, join(app, 'src/main.ts'), 'run'].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(app)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(path)}<key>T3_FACTORY_CONFIG</key>${string(config)}<key>NODE_NO_WARNINGS</key><string>1</string></dict>
<key>StandardOutPath</key>${string(join(home, 'Library/Logs/t3-factory.log'))}
<key>StandardErrorPath</key>${string(join(home, 'Library/Logs/t3-factory-error.log'))}
`);
const bin = join(home, '.local/bin/t3-factory');
mkdirSync(dirname(bin), { recursive: true });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
writeFileSync(bin, `#!/bin/sh\nPATH=${quote(path)}\nexport PATH\nexec ${quote(process.execPath)} ${quote(join(app, 'src/main.ts'))} "$@"\n`);
chmodSync(bin, 0o755);
execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'inherit' });
await bootstrap(domain, plist);
console.log(`Installed ${label} at ${app}`);
