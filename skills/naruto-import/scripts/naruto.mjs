#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { deepStrictEqual } from 'node:assert/strict';
import protocol from './protocol.cjs';

const [command, input, output, ...extra] = process.argv.slice(2);
const usage = 'Usage: node naruto.mjs <encode|decode> INPUT [OUTPUT]\nOmit OUTPUT to write the result to stdout.\n';

if (command === '--help' || command === '-h') {
  process.stdout.write(usage);
} else if (!['encode', 'decode'].includes(command) || !input || extra.length) {
  process.stderr.write(usage);
  process.exitCode = 1;
} else {
  try {
    const source = await readFile(input, 'utf8');
    let result;
    if (command === 'encode') {
      const packet = protocol.parsePacket(source);
      result = await protocol.encodePacket(packet);
      deepStrictEqual(await protocol.decodePacket(result), packet);
    } else {
      result = JSON.stringify(await protocol.decodePacket(source), null, 2);
    }
    if (output) {
      await writeFile(output, result + '\n', 'utf8');
    } else {
      process.stdout.write(result + '\n');
    }
  } catch (error) {
    process.stderr.write(`Naruto: ${error.message}\n`);
    process.exitCode = 1;
  }
}
