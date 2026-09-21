// Generate cross-language fixtures using the actual VS Code exporter, not a second codec.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'naruto-fixture-'));
try {
  const output = join(temporary, 'protocol.cjs');
  await build({ entryPoints: [join(root, 'src/transferProtocol.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' });
  const { encodePacket, createExportBlocks } = createRequire(import.meta.url)(output);
  const packet = {
    format: 'naruto-virtual-workspace', version: 1,
    operations: [
      { action: 'mkdir', workspace: '示例 project', path: '.' },
      { action: 'mkdir', workspace: '示例 project', path: 'empty folder' },
      { action: 'write', workspace: '示例 project', path: 'src/你好.ts', encoding: 'utf8', content: 'export const hello = "你好 🍥";\n:base64: stays text\n' },
      { action: 'write', workspace: '示例 project', path: 'binary.bin', encoding: 'base64', content: Buffer.from([0, 255, 128, 1, 10, 13]).toString('base64') },
      { action: 'write', workspace: 'other-workspace', path: 'empty.txt', encoding: 'utf8', content: '' },
      { action: 'write', workspace: 'other-workspace', path: 'large.txt', encoding: 'utf8', content: 'Naruto 跨语言传输验证\n'.repeat(6000) },
    ],
  };
  const blocks = createExportBlocks(await encodePacket(packet), 73);
  const destination = join(root, '../mac-naruto-receiver/Tests/NarutoTransferTests/Fixtures/export.json');
  await writeFile(destination, JSON.stringify({ blocks }, null, 2) + '\n');
  console.log(`Generated ${blocks.length - 1} data chunks from the VS Code exporter.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
