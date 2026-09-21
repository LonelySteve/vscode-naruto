import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: mkdtempSync(join(tmpdir(), 'naruto-tests-')),
	useInstallation: process.env.VSCODE_EXECUTABLE_PATH
		? { fromPath: process.env.VSCODE_EXECUTABLE_PATH }
		: undefined,
	launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
	mocha: { timeout: 15000 },
});
