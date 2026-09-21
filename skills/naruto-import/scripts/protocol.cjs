// Generated from vscode-naruto. Run pnpm skill:build to update. See ../LICENSE.txt.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../node_modules/.pnpm/json-buffer@3.0.1/node_modules/json-buffer/index.js
var require_json_buffer = __commonJS({
  "../../node_modules/.pnpm/json-buffer@3.0.1/node_modules/json-buffer/index.js"(exports2) {
    exports2.stringify = function stringify(o) {
      if ("undefined" == typeof o) return o;
      if (o && Buffer.isBuffer(o))
        return JSON.stringify(":base64:" + o.toString("base64"));
      if (o && o.toJSON)
        o = o.toJSON();
      if (o && "object" === typeof o) {
        var s = "";
        var array = Array.isArray(o);
        s = array ? "[" : "{";
        var first = true;
        for (var k in o) {
          var ignore = "function" == typeof o[k] || !array && "undefined" === typeof o[k];
          if (Object.hasOwnProperty.call(o, k) && !ignore) {
            if (!first)
              s += ",";
            first = false;
            if (array) {
              if (o[k] == void 0)
                s += "null";
              else
                s += stringify(o[k]);
            } else if (o[k] !== void 0) {
              s += stringify(k) + ":" + stringify(o[k]);
            }
          }
        }
        s += array ? "]" : "}";
        return s;
      } else if ("string" === typeof o) {
        return JSON.stringify(/^:/.test(o) ? ":" + o : o);
      } else if ("undefined" === typeof o) {
        return "null";
      } else
        return JSON.stringify(o);
    };
    exports2.parse = function(s) {
      return JSON.parse(s, function(key, value) {
        if ("string" === typeof value) {
          if (/^:base64:/.test(value))
            return Buffer.from(value.substring(8), "base64");
          else
            return /^:/.test(value) ? value.substring(1) : value;
        }
        return value;
      });
    };
  }
});

// ../../node_modules/.pnpm/compress-brotli@1.3.13/node_modules/compress-brotli/src/merge-options.js
var require_merge_options = __commonJS({
  "../../node_modules/.pnpm/compress-brotli@1.3.13/node_modules/compress-brotli/src/merge-options.js"(exports2, module2) {
    "use strict";
    module2.exports = (defaultOptions = {}, options = {}) => {
      const params = {
        ...defaultOptions.params || {},
        ...options.params || {}
      };
      return {
        ...defaultOptions,
        ...options,
        ...Object.keys(params).length ? {
          params
        } : {}
      };
    };
  }
});

// ../../node_modules/.pnpm/compress-brotli@1.3.13/node_modules/compress-brotli/src/index.js
var require_src = __commonJS({
  "../../node_modules/.pnpm/compress-brotli@1.3.13/node_modules/compress-brotli/src/index.js"(exports2, module2) {
    "use strict";
    var { promisify } = require("util");
    var JSONB = require_json_buffer();
    var zlib = require("zlib");
    var mergeOptions = require_merge_options();
    var compress = promisify(zlib.brotliCompress);
    var decompress = promisify(zlib.brotliDecompress);
    var identity = (val) => val;
    var createCompress2 = ({
      enable = true,
      serialize = JSONB.stringify,
      deserialize = JSONB.parse,
      compressOptions,
      decompressOptions
    } = {}) => {
      if (!enable) {
        return { serialize, deserialize, decompress: identity, compress: identity };
      }
      return {
        serialize,
        deserialize,
        compress: async (data, options = {}) => {
          if (data === void 0) return data;
          const serializedData = serialize(data);
          return compress(serializedData, mergeOptions(compressOptions, options));
        },
        decompress: async (data, options = {}) => {
          if (data === void 0) return data;
          return deserialize(
            await decompress(data, mergeOptions(decompressOptions, options))
          );
        }
      };
    };
    module2.exports = createCompress2;
    module2.exports.stringify = JSONB.stringify;
    module2.exports.parse = JSONB.parse;
  }
});

// naruto-skill-codec.ts
var naruto_skill_codec_exports = {};
__export(naruto_skill_codec_exports, {
  decodePacket: () => decodePacket,
  encodePacket: () => encodePacket,
  parsePacket: () => parsePacket
});
module.exports = __toCommonJS(naruto_skill_codec_exports);

// src/transferProtocol.ts
var import_compress_brotli = __toESM(require_src());

// src/base91.ts
var BASE91_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
var BASE91_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  table.fill(-1);
  for (let i = 0; i < BASE91_ALPHABET.length; i += 1) {
    table[BASE91_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();
function isWhitespaceCharCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13;
}
function base91Encode(input) {
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
      output += BASE91_ALPHABET[v % 91] + BASE91_ALPHABET[Math.floor(v / 91)];
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
function base91Decode(text, options) {
  const ignoreWhitespace = options?.ignoreWhitespace ?? true;
  let b = 0;
  let n = 0;
  let v = -1;
  const output = [];
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

// src/transferProtocol.ts
var codec = (0, import_compress_brotli.default)();
function validPath(value) {
  return typeof value === "string" && value.length > 0 && !/[\\\x00-\x1f]/.test(value) && (value === "." || value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}
function parsePacket(text) {
  const packet = JSON.parse(text);
  if (packet?.format !== "naruto-virtual-workspace" || packet.version !== 1 || !Array.isArray(packet.operations)) {
    throw new Error("\u4E0D\u662F\u53D7\u652F\u6301\u7684 Naruto \u865A\u62DF\u5DE5\u4F5C\u533A\u6570\u636E\u5305");
  }
  for (const [index, op] of packet.operations.entries()) {
    const fail = () => {
      throw new Error(`\u7B2C ${index + 1} \u9879\u64CD\u4F5C\u683C\u5F0F\u65E0\u6548`);
    };
    if (!op || typeof op.workspace !== "string" || !op.workspace || !validPath(op.path)) {
      fail();
    }
    if (op.path === "." && op.action !== "mkdir") {
      fail();
    }
    switch (op.action) {
      case "write":
      case "create":
        if (typeof op.content !== "string" || !["utf8", "base64"].includes(op.encoding)) {
          fail();
        }
        if (op.encoding === "base64" && Buffer.from(op.content, "base64").toString("base64") !== op.content) {
          fail();
        }
        break;
      case "rename":
        if (!validPath(op.to) || op.to === ".") {
          fail();
        }
        break;
      case "mkdir":
      case "delete":
        break;
      default:
        fail();
    }
  }
  return packet;
}
async function encodePacket(packet) {
  return base91Encode(await codec.compress(JSON.stringify(packet)));
}
async function decodePacket(text) {
  return parsePacket(await codec.decompress(base91Decode(text)));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decodePacket,
  encodePacket,
  parsePacket
});
