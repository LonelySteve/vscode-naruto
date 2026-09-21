import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = join(root, '../../skills/naruto-import');
await build({
  stdin: {
    contents: 'export { encodePacket, decodePacket, parsePacket } from "./src/transferProtocol";',
    resolveDir: root,
    sourcefile: 'naruto-skill-codec.ts',
    loader: 'ts',
  },
  absWorkingDir: root,
  outfile: join(skill, 'scripts/protocol.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  banner: { js: '// Generated from vscode-naruto. Run pnpm skill:build to update. See ../LICENSE.txt.' },
});

const require = createRequire(import.meta.url);
const compressRoot = dirname(require.resolve('compress-brotli/package.json'));
const jsonBufferRoot = dirname(createRequire(join(compressRoot, 'package.json')).resolve('json-buffer/package.json'));
const licenses = await Promise.all([
  readFile(join(root, '../../LICENSE'), 'utf8'),
  readFile(join(compressRoot, 'LICENSE.md'), 'utf8'),
  readFile(join(jsonBufferRoot, 'LICENSE'), 'utf8'),
]);
await writeFile(join(skill, 'LICENSE.txt'), licenses.map((text, i) => `${['Naruto', 'compress-brotli', 'json-buffer'][i]}\n\n${text.trim().replace(/[ \t]+$/gm, '')}\n`).join('\n'));
console.log('Built standalone naruto-import codec from the extension protocol.');
