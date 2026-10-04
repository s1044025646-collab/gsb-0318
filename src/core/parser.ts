import { ErrorCode, HexError } from './errors';

/** 解析器输出格式版本。语义变化时递增。 */
export const PARSER_FORMAT_VERSION = 1;

export const UINT32_MAX = 0xffffffff;

/** 支持的记录类型（本项目的明确子集）。 */
export const RECORD_TYPES = {
  DATA: 0x00,
  EOF: 0x01,
  EXT_SEGMENT: 0x02,
  START_SEGMENT: 0x03,
  EXT_LINEAR: 0x04,
  START_LINEAR: 0x05,
} as const;

/** 各类型的字段数据长度约束（数据记录由字节计数决定）。 */
const FIXED_LENGTHS: Partial<Record<number, number>> = {
  [RECORD_TYPES.EOF]: 0,
  [RECORD_TYPES.EXT_SEGMENT]: 2,
  [RECORD_TYPES.START_SEGMENT]: 4,
  [RECORD_TYPES.EXT_LINEAR]: 2,
  [RECORD_TYPES.START_LINEAR]: 4,
};

export interface RawRecord {
  /** 原文行号，从 1 开始（按非空行计数）。 */
  line: number;
  /** 该行去除换行后的原始文本（大写规范化前）。 */
  raw: string;
  count: number;
  /** 记录内 16 位偏移字段。 */
  offset: number;
  type: number;
  /** 数据/字段字节。 */
  data: Buffer;
  checksum: number;
}

export interface PlacedByte {
  address: number;
  value: number;
  line: number;
}

export interface StartAddress {
  /** 03 = 启动段地址（CS:IP 组合为 (CS<<4)+IP），05 = 扩展线性启动地址。 */
  kind: 0x03 | 0x05;
  address: number;
  line: number;
}

export interface ParsedFile {
  records: RawRecord[];
  /** 按绝对地址放置的字节（乱序、重叠由后续映射阶段处理）。 */
  bytes: PlacedByte[];
  startAddresses: StartAddress[];
  eofLine: number;
  /** 原文 SHA-256，十六进制小写。 */
  sha256: string;
}

const HEX_RE = /^[0-9A-Fa-f]*$/;

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new HexError(code, message, details);
}

function parseLine(rawLine: string, line: number): RawRecord {
  const raw = rawLine;
  if (!raw.startsWith(':')) {
    fail('BAD_LINE_FORMAT', `第 ${line} 行必须以冒号 ':' 开头`, { line });
  }
  const payload = raw.slice(1);
  if (payload.length < 10) {
    fail('LINE_TOO_SHORT', `第 ${line} 行字符数不足，无法构成合法记录`, { line });
  }
  if (!HEX_RE.test(payload)) {
    // 非十六进制字符通常意味着行内空白或多余内容。
    if (/\s/.test(payload)) {
      fail('LINE_INLINE_WHITESPACE', `第 ${line} 行不允许行内空白`, { line });
    }
    fail('INVALID_HEX_CHAR', `第 ${line} 行包含非十六进制字符或多余内容`, { line });
  }
  if (payload.length % 2 !== 0) {
    fail('ODD_HEX_LENGTH', `第 ${line} 行十六进制字符数必须为偶数`, { line, length: payload.length });
  }

  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i += 2) {
    bytes.push(parseInt(payload.substr(i, 2), 16));
  }

  const count = bytes[0];
  const offset = (bytes[1] << 8) | bytes[2];
  const type = bytes[3];
  const data = Buffer.from(bytes.slice(4, 4 + count));
  const expected = bytes.length === 4 + count + 1 ? bytes[4 + count] : undefined;

  if (bytes.length !== 4 + count + 1) {
    fail('COUNT_MISMATCH', `第 ${line} 行实际数据长度与字节计数不符`, {
      line,
      declared: count,
      actual: bytes.length - 5,
    });
  }

  // 校验：全部字节（含校验字节）之和模 256 必须为 0。
  const sum = (count + bytes[1] + bytes[2] + type + data.reduce((a, b) => a + b, 0) + (expected ?? 0)) & 0xff;
  if (sum !== 0) {
    fail('CHECKSUM_FAILED', `第 ${line} 行校验和错误`, {
      line,
      checksum: expected,
      sum,
    });
  }

  // 类型专属长度校验（数据类型长度任意但受 64K 边界限制）。
  if (type !== RECORD_TYPES.DATA) {
    if (!(type in FIXED_LENGTHS)) {
      fail('UNSUPPORTED_RECORD_TYPE', `第 ${line} 行记录类型 0x${type.toString(16).padStart(2, '0')} 不被支持`, {
        line,
        type,
      });
    }
    if (FIXED_LENGTHS[type] !== count) {
      fail('TYPE_LENGTH_MISMATCH', `第 ${line} 行类型 ${type} 要求 ${FIXED_LENGTHS[type]} 个数据字节，实际 ${count} 个`, {
        line,
        type,
        expected: FIXED_LENGTHS[type],
        actual: count,
      });
    }
  }

  return { line, raw, count, offset, type, data, checksum: expected! };
}

function readU16(b: Buffer): number {
  return (b[0] << 8) | b[1];
}

function readU32(b: Buffer): number {
  // 使用无符号 32 位运算（>>> 0 防止被当作有符号）。
  return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
}

/**
 * 解析 Intel HEX 文本并维护扩展地址状态。
 * 仅支持 00/01/02/03/04/05；03/05 作为启动地址元数据，不改变数据基址。
 */
export function parseIntelHex(text: string, sha256: string): ParsedFile {
  if (text.length === 0) {
    throw new HexError('EMPTY_FILE', '文件为空');
  }
  // 去掉 UTF-8 BOM；按常见换行切分。
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r\n|\r|\n/);

  const records: RawRecord[] = [];
  const bytes: PlacedByte[] = [];
  const startAddresses: StartAddress[] = [];

  let base = 0; // 当前绝对数据基址
  let sawEof = false;
  let eofLine = -1;

  lines.forEach((lineText, idx) => {
    const line = idx + 1;
    const trimmed = lineText.trim();
    if (trimmed === '') return; // 允许空行
    if (sawEof) {
      throw new HexError('RECORD_AFTER_EOF', `第 ${line} 行出现在文件结束记录之后`, {
        line,
        eofLine,
      });
    }

    const rec = parseLine(trimmed, line);

    switch (rec.type) {
      case RECORD_TYPES.EXT_LINEAR: {
        base = readU16(rec.data) * 0x10000;
        break;
      }
      case RECORD_TYPES.EXT_SEGMENT: {
        base = readU16(rec.data) * 0x10;
        break;
      }
      case RECORD_TYPES.DATA: {
        for (let i = 0; i < rec.data.length; i++) {
          const address = base + rec.offset + i;
          if (address > UINT32_MAX) {
            throw new HexError('ADDRESS_OVERFLOW', `第 ${line} 行产生超出无符号 32 位范围的绝对地址`, {
              line,
              base,
              offset: rec.offset,
              byteIndex: i,
            });
          }
          // 拒绝单条数据跨越 16 位偏移边界（0xFFFF -> 0x0000 回绕）。
          const byteOffset = rec.offset + i;
          if (byteOffset > 0xffff) {
            throw new HexError('CROSSES_64K_BOUNDARY', `第 ${line} 行数据跨越 64K 偏移边界`, {
              line,
              offset: rec.offset,
              length: rec.data.length,
            });
          }
          bytes.push({ address, value: rec.data[i], line });
        }
        break;
      }
      case RECORD_TYPES.START_SEGMENT: {
        const cs = (rec.data[0] << 8) | rec.data[1];
        const ip = (rec.data[2] << 8) | rec.data[3];
        const address = (cs * 16 + ip) >>> 0;
        startAddresses.push({ kind: 0x03, address, line });
        break;
      }
      case RECORD_TYPES.START_LINEAR: {
        startAddresses.push({ kind: 0x05, address: readU32(rec.data), line });
        break;
      }
      case RECORD_TYPES.EOF: {
        sawEof = true;
        eofLine = line;
        break;
      }
      default: {
        // parseLine 已对未知类型报错，此处仅为穷尽性保护。
        throw new HexError('UNSUPPORTED_RECORD_TYPE', `记录类型 ${rec.type} 不被支持`, { line });
      }
    }

    records.push(rec);
  });

  if (!sawEof) {
    throw new HexError('MISSING_EOF', '缺少合法的文件结束记录（类型 01）');
  }

  return { records, bytes, startAddresses, eofLine, sha256 };
}
