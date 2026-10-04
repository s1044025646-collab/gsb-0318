import { HexError } from './errors';
import { PlacedByte, UINT32_MAX } from './parser';

/** 某个绝对地址上的一个字节及其全部来源记录。 */
export interface MappedByte {
  address: number;
  value: number;
  /** 写入该地址的记录行号；相同内容重叠时保留多条来源。 */
  sources: number[];
}

/** 连续已定义字节组成的区间（空洞不会被补零或合并）。 */
export interface Segment {
  start: number;
  end: number; // 含端点
  length: number;
  bytes: MappedByte[];
}

export interface Gap {
  start: number;
  end: number;
  length: number;
}

export interface BuildResult {
  bytes: MappedByte[];
  segments: Segment[];
}

/**
 * 由放置后的字节构建稀疏映射：
 * - 相同地址写入相同字节：合并并保留全部来源行号；
 * - 相同地址写入不同字节：整次导入失败（绝不最后写入覆盖）；
 * - 相邻已定义字节合并为区间，空洞保持空洞。
 */
export function buildSparseMap(placed: PlacedByte[]): BuildResult {
  const byAddress = new Map<number, MappedByte>();

  for (const pb of placed) {
    const existing = byAddress.get(pb.address);
    if (!existing) {
      byAddress.set(pb.address, { address: pb.address, value: pb.value, sources: [pb.line] });
    } else if (existing.value === pb.value) {
      if (!existing.sources.includes(pb.line)) existing.sources.push(pb.line);
    } else {
      throw new HexError(
        'CONFLICTING_DATA',
        `绝对地址 0x${pb.address.toString(16).toUpperCase().padStart(8, '0')} 出现冲突字节：` +
          `第 ${existing.sources[0]} 行=0x${existing.value.toString(16).padStart(2, '0').toUpperCase()}，` +
          `第 ${pb.line} 行=0x${pb.value.toString(16).padStart(2, '0').toUpperCase()}`,
        {
          address: pb.address,
          firstLine: existing.sources[0],
          firstValue: existing.value,
          conflictLine: pb.line,
          conflictValue: pb.value,
        },
      );
    }
  }

  const bytes = [...byAddress.values()].sort((a, b) => a.address - b.address);
  const segments: Segment[] = [];
  for (const mb of bytes) {
    const last = segments[segments.length - 1];
    if (last && mb.address === last.end + 1) {
      last.end = mb.address;
      last.length++;
      last.bytes.push(mb);
    } else {
      segments.push({ start: mb.address, end: mb.address, length: 1, bytes: [mb] });
    }
  }

  return { bytes, segments };
}

export interface RangeCoverage {
  /** 与请求区间相交、按地址排序的已定义区间。 */
  covered: { start: number; end: number }[];
  gaps: Gap[];
  coveredBytes: number;
}

/** 查询 [start, end] 内已定义字节覆盖情况与空洞位置。 */
export function coverage(segments: Segment[], start: number, end: number): RangeCoverage {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > UINT32_MAX ||
    start > end
  ) {
    throw new HexError('INVALID_RANGE', `非法地址区间：0x${start.toString(16)}..0x${end.toString(16)}`, {
      start,
      end,
    });
  }

  const covered: { start: number; end: number }[] = [];
  for (const seg of segments) {
    const s = Math.max(seg.start, start);
    const e = Math.min(seg.end, end);
    if (s <= e) covered.push({ start: s, end: e });
  }

  const gaps: Gap[] = [];
  let cursor = start;
  for (const c of covered) {
    if (c.start > cursor) {
      gaps.push({ start: cursor, end: c.start - 1, length: c.start - cursor });
    }
    cursor = c.end + 1;
  }
  if (cursor <= end) gaps.push({ start: cursor, end, length: end - cursor + 1 });

  const coveredBytes = covered.reduce((a, c) => a + (c.end - c.start + 1), 0);
  return { covered, gaps, coveredBytes };
}

export interface ExportOptions {
  start: number;
  end: number;
  /** 区间字节数上限（含端点）。 */
  maxBytes: number;
  /** 空洞处理：reject = 拒绝；fill = 用 fillByte 填充。 */
  gapPolicy: 'reject' | 'fill';
  fillByte?: number;
}

export interface ExportResult {
  data: Buffer;
  length: number;
  filledGaps: Gap[];
  filledBytes: number;
}

/** 导出指定区间的二进制。区间过大或存在空洞且未授权填充时失败。 */
export function exportRange(mapped: MappedByte[], opts: ExportOptions): ExportResult {
  const { start, end, maxBytes } = opts;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > UINT32_MAX ||
    start > end
  ) {
    throw new HexError('INVALID_RANGE', `非法导出区间`, { start, end });
  }
  const length = end - start + 1;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new HexError('BAD_REQUEST', 'maxBytes 必须为正整数', { maxBytes });
  }
  if (length > maxBytes) {
    throw new HexError('EXPORT_TOO_LARGE', `导出区间 ${length} 字节超过上限 ${maxBytes} 字节`, {
      length,
      maxBytes,
    });
  }
  if (opts.gapPolicy === 'fill') {
    if (
      opts.fillByte === undefined ||
      !Number.isInteger(opts.fillByte) ||
      opts.fillByte < 0 ||
      opts.fillByte > 0xff
    ) {
      throw new HexError('BAD_REQUEST', 'fill 模式要求 fillByte 为 0..255 的整数', {
        fillByte: opts.fillByte,
      });
    }
  }

  const valueByAddress = new Map<number, number>();
  for (const mb of mapped) valueByAddress.set(mb.address, mb.value);

  const data = Buffer.alloc(length, opts.gapPolicy === 'fill' ? opts.fillByte! : 0);
  const filledGaps: Gap[] = [];
  let filledBytes = 0;
  let gapStart = -1;

  for (let i = 0; i < length; i++) {
    const addr = start + i;
    const v = valueByAddress.get(addr);
    if (v !== undefined) {
      data[i] = v;
      if (gapStart >= 0) {
        filledGaps.push({ start: gapStart, end: addr - 1, length: addr - gapStart });
        gapStart = -1;
      }
    } else if (opts.gapPolicy === 'fill') {
      filledBytes++;
      if (gapStart < 0) gapStart = addr;
    } else {
      throw new HexError(
        'EXPORT_HAS_GAPS',
        `区间 0x${start.toString(16).toUpperCase()}..0x${end.toString(16).toUpperCase()} 包含空洞；` +
          `请选择 reject 之外的策略并提供填充字节`,
        { start, end, firstGapAddress: addr },
      );
    }
  }
  if (gapStart >= 0) {
    filledGaps.push({ start: gapStart, end, length: end - gapStart + 1 });
  }

  return { data, length, filledGaps, filledBytes };
}
