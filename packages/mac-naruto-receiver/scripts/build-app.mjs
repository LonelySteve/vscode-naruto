import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Naruto Receiver requires macOS.');
const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
run('swift', ['build', '-c', 'release', '--scratch-path', '.build']);
const binaryDirectory = execFileSync('swift', ['build', '-c', 'release', '--scratch-path', '.build', '--show-bin-path'], { cwd: root, encoding: 'utf8' }).trim();
const contents = join(root, 'dist', 'Naruto Receiver.app', 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
cpSync(join(binaryDirectory, 'NarutoReceiver'), join(contents, 'MacOS', 'NarutoReceiver'));
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>NarutoReceiver</string>
  <key>CFBundleIdentifier</key><string>dev.naruto.mac-receiver</string>
  <key>CFBundleName</key><string>Naruto Receiver</string>
  <key>CFBundleDisplayName</key><string>Naruto Receiver</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
// Local development signature. Distribution requires a Developer ID and notarization.
run('codesign', ['--force', '--sign', '-', join(root, 'dist', 'Naruto Receiver.app')]);
console.log(`Built ${join(root, 'dist', 'Naruto Receiver.app')}`);
