import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

import { loadEnvironment } from '../src/env.ts';
loadEnvironment();
const bundleId = process.env.T3_FACTORY_MENU_BUNDLE_ID ?? 'local.t3-factory.menu';
if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Invalid menu bundle ID');

const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'build', 'T3 Factory.app');
const contents = join(bundle, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
  ...readdirSync(join(root, 'macos')).filter(f => f.endsWith('.swift')).sort().map(f => join(root, 'macos', f)), '-o', join(contents, 'MacOS/T3Factory')], { stdio: 'inherit' });
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>T3 Factory</string>
<key>CFBundleDisplayName</key><string>T3 Factory</string>
<key>CFBundleExecutable</key><string>T3Factory</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
console.log(bundle);
