import { HexError } from "./errors.js";
import type { ParsedRecord } from "./parser.js";

export interface ByteSource {
  address: number;
  value: number;
  lineNo: number;
}

export interface Segment {
  start: number;      // 含
  end: number;        // 不含
  data: Buffer;
}

export interface SparseMap {
  segments: Segment[];
  sources: ByteSource[]; // 每字节来源（含重复写入的全部来源）
  byteCount: number;
}

// 将数据记录还原为稀疏字节映射。重叠同值合并并保留双方来源；异值整体失败。
export function buildSparseMap(records: ParsedRecord[]): SparseMap {
  const bytes = new Map<number, { value: number; lines: number[] }>();

  for (const rec of records) {
    if (rec.type !== 0x00 || rec.byteCount === 0) continue;
    const abs = rec.absStart!;
    for (let i = 0; i < rec.byteCount; i++) {
      const addr = abs + i;
      const value = rec.data[i];
      const prev = bytes.get(addr);
      if (prev) {
        if (prev.value !== value) {
          throw new HexError(
            "E_CONFLICT",
            `地址 0x${addr.toString(16).toUpperCase().padStart(8, "0")} 冲突：第 ${prev.lines[0]} 行写入 0x${prev.value.toString(16).padStart(2, "0")}，第 ${rec.lineNo} 行写入 0x${value.toString(16).padStart(2, "0")}`,
            { address: addr, lineA: prev.lines[0], lineB: rec.lineNo, valueA: prev.value, valueB: value }
          );
        }
        prev.lines.push(rec.lineNo);
      } else {
        bytes.set(addr, { value, lines: [rec.lineNo] });
      }
    }
  }

  const addrs = [...bytes.keys()].sort((a, b) => a - b);
  const segments: Segment[] = [];
  const sources: ByteSource[] = [];
  let i = 0;
  while (i < addrs.length) {
    const start = addrs[i];
    const chunk: number[] = [bytes.get(start)!.value];
    for (const l of bytes.get(start)!.lines) sources.push({ address: start, value: bytes.get(start)!.value, lineNo: l });
    let j = i + 1;
    while (j < addrs.length && addrs[j] === addrs[j - 1] + 1) {
      const a = addrs[j];
      chunk.push(bytes.get(a)!.value);
      for (const l of bytes.get(a)!.lines) sources.push({ address: a, value: bytes.get(a)!.value, lineNo: l });
      j++;
    }
    segments.push({ start, end: addrs[j - 1] + 1, data: Buffer.from(chunk) });
    i = j;
  }
  return { segments, sources, byteCount: addrs.length };
}

export const DEFAULT_MAX_EXPORT = 1024 * 1024; // 1 MiB

export interface ExportResult {
  data: Buffer;
  filledHoles: { start: number; end: number }[];
}

export function exportRange(
  segments: Segment[],
  start: number,
  end: number, // 不含
  opts: { fill?: number; maxSize?: number } = {}
): ExportResult {
  const maxSize = opts.maxSize ?? DEFAULT_MAX_EXPORT;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - 1 > 0xffffffff) {
    throw new HexError("E_RANGE", "导出范围非法：要求 0 <= start < end <= 0x100000000");
  }
  const size = end - start;
  if (size > maxSize) {
    throw new HexError("E_RANGE", `导出范围 ${size} 字节超过上限 ${maxSize}`, { size, maxSize });
  }
  const fill = opts.fill;
  if (fill !== undefined && (!Number.isInteger(fill) || fill < 0 || fill > 0xff)) {
    throw new HexError("E_VALIDATION", "填充字节必须是 0x00-0xFF 的整数");
  }

  const out = Buffer.alloc(size, fill ?? 0);
  const holes: { start: number; end: number }[] = [];
  let cursor = start;
  for (const seg of segments) {
    if (seg.end <= start || seg.start >= end) continue;
    const s = Math.max(seg.start, start);
    const e = Math.min(seg.end, end);
    if (cursor < s) holes.push({ start: cursor, end: s });
    seg.data.copy(out, s - start, s - seg.start, e - seg.start);
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) holes.push({ start: cursor, end });

  if (holes.length > 0 && fill === undefined) {
    throw new HexError("E_HOLE", "导出范围包含空洞，请明确选择拒绝或指定填充字节", { holes });
  }
  return { data: out, filledHoles: holes };
}
