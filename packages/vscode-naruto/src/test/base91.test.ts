import * as assert from "assert";
import { base91Decode, base91Encode, BASE91_ALPHABET } from "../base91";

suite("Base91 Codec", () => {
  test("encodes and decodes empty input", () => {
    const encoded = base91Encode(new Uint8Array());
    assert.strictEqual(encoded, "");

    const decoded = base91Decode(encoded);
    assert.strictEqual(decoded.length, 0);
  });

  test("roundtrip UTF-8 text", () => {
    const text = "你好, Naruto! hello world";
    const encoded = base91Encode(text);
    const decoded = base91Decode(encoded);
    const decodedText = Buffer.from(decoded).toString("utf8");
    assert.strictEqual(decodedText, text);
  });

  test("roundtrip binary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      bytes[i] = i;
    }

    const encoded = base91Encode(bytes);
    const decoded = base91Decode(encoded);
    assert.deepStrictEqual(Array.from(decoded), Array.from(bytes));
  });

  test("output only uses base91 alphabet", () => {
    const encoded = base91Encode("Base91 output check");
    for (const char of encoded) {
      assert.ok(
        BASE91_ALPHABET.includes(char),
        `Unexpected character: ${char}`
      );
    }
  });

  test("decoding ignores whitespace by default", () => {
    const original = "Chunked text\nwith whitespace";
    const encoded = base91Encode(original);
    const chunked = encoded.slice(0, 4) + "\n" + encoded.slice(4) + "  ";
    const decoded = base91Decode(chunked);
    assert.strictEqual(Buffer.from(decoded).toString("utf8"), original);
  });

  test("decoding invalid characters throws", () => {
    assert.throws(
      () => base91Decode("abc ", { ignoreWhitespace: false }),
      /Invalid base91 character/
    );
  });
});
