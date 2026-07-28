/**
 * Minimal LHA/LH5 decoder for POS electronic journal archives.
 *
 * Supported archive shape:
 * - LHA header level 0/1/2
 * - compression methods -lh0- and -lh5-
 * - one or more regular-file entries (directories are ignored)
 *
 * The LH5 decoding algorithm is derived from the BSD-licensed python-lhafile
 * implementation by Hidekazu Ohnishi. This module is a clean TypeScript port
 * restricted to the formats needed by the POS journal import flow.
 */

export type LhaArchiveEntry = {
  fileName: string;
  method: "-lh0-" | "-lh5-";
  compressedSize: number;
  originalSize: number;
  crc16: number;
  dataOffset: number;
};

export type ExtractedLhaEntry = LhaArchiveEntry & { data: Uint8Array };

const LH5_DICT_SIZE = 8192;
const MAX_ENTRY_COUNT = 100;
const MAX_DECOMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED_BYTES = 24 * 1024 * 1024;

function readU16LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error("LHA header is truncated.");
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error("LHA header is truncated.");
  }
  return (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || start + length > bytes.length) {
    throw new Error("LHA header is truncated.");
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i]);
  }
  return out;
}

function safeArchiveFileName(value: string): string {
  const leaf = String(value || "").replace(/\\/g, "/").split("/").pop() ||
    "journal.jnl";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean || "journal.jnl";
}

function parseLevel2Entry(
  bytes: Uint8Array,
  offset: number,
): LhaArchiveEntry | null {
  if (offset + 26 > bytes.length) {
    throw new Error("LHA level-2 header is truncated.");
  }
  const headerSize = readU16LE(bytes, offset);
  if (headerSize === 0) return null;
  if (headerSize < 26 || offset + headerSize > bytes.length) {
    throw new Error("LHA level-2 header size is invalid.");
  }
  const method = ascii(bytes, offset + 2, 5);
  const compressedSize = readU32LE(bytes, offset + 7);
  const originalSize = readU32LE(bytes, offset + 11);
  const level = bytes[offset + 20];
  if (level !== 2) throw new Error(`Unsupported LHA header level: ${level}.`);
  const crc = readU16LE(bytes, offset + 21);
  let extSize = readU16LE(bytes, offset + 24);
  let cursor = offset + 26;
  let name = "";
  let directory = "";
  while (extSize !== 0) {
    const currentSize = extSize;
    if (currentSize < 3 || cursor + currentSize > bytes.length) {
      throw new Error("LHA extended header is invalid.");
    }
    const type = bytes[cursor];
    const payload = bytes.slice(cursor + 1, cursor + currentSize - 2);
    if (type === 0x01) name = ascii(payload, 0, payload.length);
    if (type === 0x02) {
      directory = ascii(payload, 0, payload.length).replace(/\xff/g, "/");
    }
    extSize = readU16LE(bytes, cursor + currentSize - 2);
    cursor += currentSize;
  }
  const dataOffset = cursor;
  if (dataOffset + compressedSize > bytes.length) {
    throw new Error("LHA compressed payload is truncated.");
  }
  if (directory && !name) return null;
  if (!name) name = "journal.jnl";
  if (method !== "-lh0-" && method !== "-lh5-" && method !== "-lhd-") {
    throw new Error(`Unsupported LHA compression method: ${method}.`);
  }
  if (method === "-lhd-") return null;
  return {
    fileName: safeArchiveFileName(name),
    method,
    compressedSize,
    originalSize,
    crc16: crc,
    dataOffset,
  };
}

function parseLevel01Entry(
  bytes: Uint8Array,
  offset: number,
  level: number,
): LhaArchiveEntry | null {
  if (offset + 22 > bytes.length) throw new Error("LHA header is truncated.");
  const headerSize = bytes[offset];
  if (headerSize === 0) return null;
  const method = ascii(bytes, offset + 2, 5);
  const skipSize = readU32LE(bytes, offset + 7);
  const originalSize = readU32LE(bytes, offset + 11);
  const nameLength = bytes[offset + 21];
  const nameStart = offset + 22;
  if (nameStart + nameLength + 2 > bytes.length) {
    throw new Error("LHA file name header is truncated.");
  }
  const name = ascii(bytes, nameStart, nameLength);
  const crc = readU16LE(bytes, nameStart + nameLength);
  let cursor = nameStart + nameLength + 2;
  let extensionBytes = 0;
  if (level === 1) {
    const baseHeaderEnd = offset + headerSize + 2;
    if (baseHeaderEnd > bytes.length) {
      throw new Error("LHA level-1 header is truncated.");
    }
    cursor = baseHeaderEnd - 2;
    let extSize = readU16LE(bytes, cursor);
    cursor += 2;
    while (extSize !== 0) {
      if (extSize < 3 || cursor + extSize - 2 > bytes.length) {
        throw new Error("LHA extended header is invalid.");
      }
      extensionBytes += extSize;
      const currentSize = extSize;
      extSize = readU16LE(bytes, cursor + currentSize - 4);
      cursor += currentSize - 2;
    }
  } else {
    cursor = offset + headerSize + 2;
  }
  const compressedSize = Math.max(0, skipSize - extensionBytes);
  if (cursor + compressedSize > bytes.length) {
    throw new Error("LHA compressed payload is truncated.");
  }
  if (method !== "-lh0-" && method !== "-lh5-" && method !== "-lhd-") {
    throw new Error(`Unsupported LHA compression method: ${method}.`);
  }
  if (method === "-lhd-") return null;
  return {
    fileName: safeArchiveFileName(name),
    method,
    compressedSize,
    originalSize,
    crc16: crc,
    dataOffset: cursor,
  };
}

export function listLhaEntries(bytes: Uint8Array): LhaArchiveEntry[] {
  if (!(bytes instanceof Uint8Array) || bytes.length < 26) {
    throw new Error("LHA file is empty or truncated.");
  }
  const entries: LhaArchiveEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (entries.length >= MAX_ENTRY_COUNT) {
      throw new Error(
        `LHA contains too many entries (max ${MAX_ENTRY_COUNT}).`,
      );
    }
    if (bytes[offset] === 0 && offset >= bytes.length - 2) break;
    if (offset + 21 > bytes.length) break;
    const level = bytes[offset + 20];
    let entry: LhaArchiveEntry | null;
    if (level === 2) entry = parseLevel2Entry(bytes, offset);
    else if (level === 0 || level === 1) {
      entry = parseLevel01Entry(bytes, offset, level);
    } else throw new Error(`Unsupported LHA header level: ${level}.`);
    if (!entry) {
      if (level === 2) {
        const headerSize = readU16LE(bytes, offset);
        const compressedSize = readU32LE(bytes, offset + 7);
        if (!headerSize) break;
        offset += headerSize + compressedSize;
      } else {
        const headerSize = bytes[offset];
        const skipSize = readU32LE(bytes, offset + 7);
        if (!headerSize) break;
        offset += headerSize + 2 + skipSize;
      }
      continue;
    }
    entries.push(entry);
    offset = entry.dataOffset + entry.compressedSize;
  }
  if (!entries.length) {
    throw new Error("LHA archive contains no supported files.");
  }
  return entries;
}

class BitReader {
  private bitPosition = 0;
  constructor(private readonly bytes: Uint8Array) {}

  fetch(bitCount: number): number {
    if (bitCount === 0) return 0;
    if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 16) {
      throw new Error("Invalid LH5 bit length.");
    }
    if (this.bitPosition + bitCount > this.bytes.length * 8) {
      throw new Error("Unexpected end of LH5 payload.");
    }
    let value = 0;
    for (let i = 0; i < bitCount; i += 1) {
      const position = this.bitPosition;
      this.bitPosition += 1;
      value = (value << 1) |
        ((this.bytes[position >> 3] >> (7 - (position & 7))) & 1);
    }
    return value;
  }
}

type HuffmanDecoder = { decode: (reader: BitReader) => number };

function makeHuffmanDecoder(lengths: number[]): HuffmanDecoder {
  const maxBits = Math.max(...lengths);
  if (maxBits < 1 || maxBits > 16) {
    throw new Error("LH5 Huffman length table is invalid.");
  }
  const counts = new Array(maxBits + 1).fill(0);
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 16) {
      throw new Error("LH5 Huffman code length is invalid.");
    }
    if (length > 0) counts[length] += 1;
  }
  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const symbols = new Map<string, number>();
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (!length) continue;
    const current = nextCode[length];
    nextCode[length] += 1;
    symbols.set(`${length}:${current}`, symbol);
  }
  return {
    decode(reader: BitReader): number {
      let current = 0;
      for (let length = 1; length <= maxBits; length += 1) {
        current = (current << 1) | reader.fetch(1);
        const symbol = symbols.get(`${length}:${current}`);
        if (symbol != null) return symbol;
      }
      throw new Error("LH5 Huffman bit pattern is invalid.");
    },
  };
}

function decodeUnary7(reader: BitReader): number {
  let code = reader.fetch(3);
  if (code === 7) { while (reader.fetch(1) === 1) code += 1; }
  return code;
}

function decodeBitLengthDecoder(reader: BitReader): HuffmanDecoder {
  const lengths = new Array(19).fill(0);
  const size = reader.fetch(5);
  if (size > 19) throw new Error("LH5 bit-length table is invalid.");
  if (size === 0) {
    const leaf = reader.fetch(5);
    if (leaf >= 19) throw new Error("LH5 bit-length leaf is invalid.");
    lengths[leaf] = 1;
  } else {
    let index = 0;
    while (index < size) {
      lengths[index] = decodeUnary7(reader);
      index += 1;
      if (index === 3) {
        let zeroCount = reader.fetch(2);
        while (zeroCount > 0 && index < lengths.length) {
          lengths[index] = 0;
          index += 1;
          zeroCount -= 1;
        }
      }
    }
  }
  return makeHuffmanDecoder(lengths);
}

function decodeLiteralLengths(
  reader: BitReader,
  bitLengthDecoder: HuffmanDecoder,
): number[] {
  const lengths = new Array(510).fill(0);
  const size = reader.fetch(9);
  if (size === 0) {
    const leaf = reader.fetch(9);
    if (leaf >= lengths.length) throw new Error("LH5 literal leaf is invalid.");
    lengths[leaf] = 1;
  } else {
    let index = 0;
    while (index < size) {
      const code = bitLengthDecoder.decode(reader);
      if (code > 2) {
        if (index >= lengths.length) {
          throw new Error("LH5 literal table overflows.");
        }
        lengths[index] = code - 2;
        index += 1;
      } else if (code === 0) {
        if (index >= lengths.length) {
          throw new Error("LH5 literal table overflows.");
        }
        lengths[index] = 0;
        index += 1;
      } else {
        let zeroCount = code === 1 ? reader.fetch(4) + 3 : reader.fetch(9) + 20;
        if (index + zeroCount > lengths.length) {
          throw new Error("LH5 literal table overflows.");
        }
        while (zeroCount > 0) {
          lengths[index] = 0;
          index += 1;
          zeroCount -= 1;
        }
      }
    }
  }
  return lengths;
}

function decodeDistanceLengths(reader: BitReader): number[] {
  const lengths = new Array(15).fill(0);
  const size = reader.fetch(4);
  if (size > lengths.length) throw new Error("LH5 distance table is invalid.");
  if (size === 0) {
    const leaf = reader.fetch(4);
    if (leaf >= lengths.length) {
      throw new Error("LH5 distance leaf is invalid.");
    }
    lengths[leaf] = 1;
  } else {
    for (let i = 0; i < size; i += 1) lengths[i] = decodeUnary7(reader);
  }
  return lengths;
}

export function decodeLh5(
  compressed: Uint8Array,
  originalSize: number,
): Uint8Array {
  if (
    !Number.isInteger(originalSize) || originalSize < 0 ||
    originalSize > MAX_DECOMPRESSED_ENTRY_BYTES
  ) {
    throw new Error(
      `LHA entry decompressed size is invalid or too large (max ${MAX_DECOMPRESSED_ENTRY_BYTES} bytes).`,
    );
  }
  const reader = new BitReader(compressed);
  const output = new Uint8Array(originalSize);
  const dictionary = new Uint8Array(LH5_DICT_SIZE);
  let dictionaryPosition = 0;
  let outputPosition = 0;
  let blockSize = 0;
  let literalDecoder: HuffmanDecoder | null = null;
  let distanceDecoder: HuffmanDecoder | null = null;

  while (outputPosition < originalSize) {
    if (blockSize <= 0) {
      blockSize = reader.fetch(16);
      if (blockSize <= 0) throw new Error("LH5 block size is invalid.");
      const bitLengthDecoder = decodeBitLengthDecoder(reader);
      literalDecoder = makeHuffmanDecoder(
        decodeLiteralLengths(reader, bitLengthDecoder),
      );
      distanceDecoder = makeHuffmanDecoder(decodeDistanceLengths(reader));
    }
    if (!literalDecoder || !distanceDecoder) {
      throw new Error("LH5 decoder is not initialized.");
    }
    const code = literalDecoder.decode(reader);
    blockSize -= 1;
    if (code < 256) {
      output[outputPosition] = code;
      outputPosition += 1;
      dictionary[dictionaryPosition] = code;
      dictionaryPosition = (dictionaryPosition + 1) & (LH5_DICT_SIZE - 1);
      continue;
    }
    let matchLength = code - 256 + 3;
    const bitLength = distanceDecoder.decode(reader);
    let distance = 1;
    if (bitLength > 0) {
      distance = reader.fetch(bitLength - 1) + (1 << (bitLength - 1)) + 1;
    }
    if (distance < 1 || distance > LH5_DICT_SIZE) {
      throw new Error("LH5 match distance is invalid.");
    }
    let sourcePosition = (dictionaryPosition - distance) & (LH5_DICT_SIZE - 1);
    while (matchLength > 0 && outputPosition < originalSize) {
      const value = dictionary[sourcePosition];
      sourcePosition = (sourcePosition + 1) & (LH5_DICT_SIZE - 1);
      dictionary[dictionaryPosition] = value;
      dictionaryPosition = (dictionaryPosition + 1) & (LH5_DICT_SIZE - 1);
      output[outputPosition] = value;
      outputPosition += 1;
      matchLength -= 1;
    }
  }
  return output;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
    }
  }
  return crc & 0xffff;
}

export function extractLhaArchive(bytes: Uint8Array): ExtractedLhaEntry[] {
  const entries = listLhaEntries(bytes);
  let totalSize = 0;
  return entries.map((entry) => {
    totalSize += entry.originalSize;
    if (totalSize > MAX_TOTAL_DECOMPRESSED_BYTES) {
      throw new Error(
        `LHA total decompressed size is too large (max ${MAX_TOTAL_DECOMPRESSED_BYTES} bytes).`,
      );
    }
    const compressed = bytes.slice(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    );
    const data = entry.method === "-lh0-"
      ? compressed.slice()
      : decodeLh5(compressed, entry.originalSize);
    if (data.length !== entry.originalSize) {
      throw new Error("LHA decompressed size does not match the header.");
    }
    if (crc16(data) !== entry.crc16) throw new Error("LHA CRC check failed.");
    return { ...entry, data };
  });
}
