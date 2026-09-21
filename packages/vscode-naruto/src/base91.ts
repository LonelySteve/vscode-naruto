const BASE91_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~\"";

const BASE91_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  table.fill(-1);
  for (let i = 0; i < BASE91_ALPHABET.length; i += 1) {
    table[BASE91_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function isWhitespaceCharCode(code: number) {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d
  );
}

export function base91Encode(input: Uint8Array | string) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  let b = 0;
  let n = 0;
  let output = "";

  for (let i = 0; i < data.length; i += 1) {
    b |= data[i] << n;
    n += 8;

    if (n > 13) {
      let v = b & 8191;
      if (v > 88) {
        b >>= 13;
        n -= 13;
      } else {
        v = b & 16383;
        b >>= 14;
        n -= 14;
      }

      output +=
        BASE91_ALPHABET[v % 91] + BASE91_ALPHABET[Math.floor(v / 91)];
    }
  }

  if (n > 0) {
    output += BASE91_ALPHABET[b % 91];
    if (n > 7 || b > 90) {
      output += BASE91_ALPHABET[Math.floor(b / 91)];
    }
  }

  return output;
}

export function base91Decode(
  text: string,
  options?: { ignoreWhitespace?: boolean }
) {
  const ignoreWhitespace = options?.ignoreWhitespace ?? true;
  let b = 0;
  let n = 0;
  let v = -1;
  const output: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);

    if (code > 255) {
      if (ignoreWhitespace && /\s/.test(text[i])) {
        continue;
      }
      throw new Error(`Invalid base91 character: ${text[i]}`);
    }

    const decoded = BASE91_DECODE_TABLE[code];
    if (decoded === -1) {
      if (ignoreWhitespace && isWhitespaceCharCode(code)) {
        continue;
      }
      throw new Error(`Invalid base91 character: ${text[i]}`);
    }

    if (v < 0) {
      v = decoded;
      continue;
    }

    v += decoded * 91;
    b |= v << n;

    if ((v & 8191) > 88) {
      n += 13;
    } else {
      n += 14;
    }

    do {
      output.push(b & 255);
      b >>= 8;
      n -= 8;
    } while (n > 7);

    v = -1;
  }

  if (v >= 0) {
    b |= v << n;
    n += 7;
    if (n > 7) {
      output.push(b & 255);
    }
  }

  return Uint8Array.from(output);
}

export { BASE91_ALPHABET };
