import { HexError } from "./errors.js";

export const FORMAT_VERSION = "ihex-subset-1";

export interface ParsedRecord {
  lineNo: number;
  raw: string;
  byteCount: number;
  offset: number;      // 记录内 16 位偏移
  type: number;
  data: Buffer;        // 不含校验字节
  checksum: number;
  base: number | null; // 本条数据记录生效的基址（仅 00 类型）
  absStart: number | null; // 绝对起始地址（仅 00 类型）
}

export interface ParseResult {
  formatVersion: string;
  records: ParsedRecord[];
  startLinearAddress: number | null; // 类型 05
  startSegmentAddress: { cs: number; ip: number } | null; // 类型 03
}

const LINE_RE = /^:([0-9A-Fa-f]{2})([0-9A-Fa-f]{4})([0-9A-Fa-f]{2})([0-9A-Fa-f]*)$/;

const TYPE_LENGTHS: Record<number, number> = {
  0x01: 0,
  0x02: 2,
  0x03: 4,
  0x04: 2,
  0x05: 4,
};

const UINT32_MAX = 0xffffffff;

export function parseIntelHex(text: string): ParseResult {
  const lines = text.split(/\r\n|\r|\n/);
  const records: ParsedRecord[] = [];
  let base = 0;
  let sawEof = false;
  let startLinear: number | null = null;
  let startSegment: { cs: number; ip: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.length === 0) continue; // 允许末尾空行
    if (sawEof) {
      throw new HexError("E_AFTER_EOF", `第 ${lineNo} 行：结束记录之后仍有非空内容`, { lineNo, line });
    }
    if (/\s/.test(line)) {
      throw new HexError("E_SYNTAX", `第 ${lineNo} 行：不允许行内空白字符`, { lineNo, line });
    }
    const m = LINE_RE.exec(line);
    if (!m) {
      throw new HexError("E_SYNTAX", `第 ${lineNo} 行：不是合法的 Intel HEX 记录`, { lineNo, line });
    }
    const byteCount = parseInt(m[1], 16);
    const offset = parseInt(m[2], 16);
    const type = parseInt(m[3], 16);
    const dataHex = m[4];

    if (dataHex.length !== (byteCount + 1) * 2) {
      throw new HexError("E_LENGTH", `第 ${lineNo} 行：声明 ${byteCount} 字节数据，实际长度不符`, {
        lineNo, declared: byteCount, actualHexChars: dataHex.length,
      });
    }
    const payload = Buffer.from(dataHex, "hex");
    const data = payload.subarray(0, byteCount);
    const checksum = payload[byteCount];

    let sum = byteCount + (offset >> 8) + (offset & 0xff) + type;
    for (const b of payload) sum += b;
    if (sum % 256 !== 0) {
      throw new HexError("E_CHECKSUM", `第 ${lineNo} 行：校验和错误（各字节和模 256 应为 0）`, { lineNo });
    }

    if (!(type in TYPE_LENGTHS) && type !== 0x00) {
      throw new HexError("E_UNSUPPORTED_TYPE", `第 ${lineNo} 行：不支持的记录类型 0x${type.toString(16).padStart(2, "0")}`, { lineNo, type });
    }
    if (type !== 0x00) {
      const want = TYPE_LENGTHS[type];
      if (byteCount !== want) {
        throw new HexError("E_TYPE_LENGTH", `第 ${lineNo} 行：类型 0x${type.toString(16).padStart(2, "0")} 要求数据长度 ${want}，实际 ${byteCount}`, { lineNo, type, byteCount });
      }
    }

    const rec: ParsedRecord = {
      lineNo, raw: line, byteCount, offset, type,
      data: Buffer.from(data), checksum, base: null, absStart: null,
    };

    switch (type) {
      case 0x00: {
        if (byteCount > 0 && offset + byteCount > 0x10000) {
          throw new HexError("E_OFFSET_OVERFLOW", `第 ${lineNo} 行：数据跨越 16 位偏移边界（子集不支持）`, { lineNo, offset, byteCount });
        }
        const abs = base + offset;
        if (byteCount > 0 && abs + byteCount - 1 > UINT32_MAX) {
          throw new HexError("E_ADDR_OVERFLOW", `第 ${lineNo} 行：绝对地址超出 32 位无符号范围`, { lineNo, abs });
        }
        rec.base = base;
        rec.absStart = abs;
        break;
      }
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        base = data.readUInt16BE(0) * 16;
        break;
      case 0x04:
        base = data.readUInt16BE(0) * 65536;
        break;
      case 0x03: {
        const cs = data.readUInt16BE(0);
        const ip = data.readUInt16BE(2);
        if (startSegment && (startSegment.cs !== cs || startSegment.ip !== ip)) {
          throw new HexError("E_META_CONFLICT", `第 ${lineNo} 行：类型 03 启动地址与之前不一致`, { lineNo });
        }
        startSegment = { cs, ip };
        break;
      }
      case 0x05: {
        const v = data.readUInt32BE(0);
        if (startLinear !== null && startLinear !== v) {
          throw new HexError("E_META_CONFLICT", `第 ${lineNo} 行：类型 05 启动地址与之前不一致`, { lineNo });
        }
        startLinear = v;
        break;
      }
    }
    records.push(rec);
  }

  if (!sawEof) {
    throw new HexError("E_EOF_MISSING", "缺少结束记录（类型 01）");
  }
  return {
    formatVersion: FORMAT_VERSION,
    records,
    startLinearAddress: startLinear,
    startSegmentAddress: startSegment,
  };
}
