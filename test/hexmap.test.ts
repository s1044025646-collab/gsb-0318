import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseIntelHex } from "../src/parser.js";
import { buildSparseMap, exportRange } from "../src/mapper.js";
import { openDb, importHex, listSegments, lookupAddress } from "../src/db.js";
import { HexError } from "../src/errors.js";

const fx = (n: string) => fs.readFileSync(path.resolve("fixtures", n), "utf8");
const expectCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HexError && e.code === code);

test("空数据 + 结束记录", () => {
  const r = parseIntelHex(fx("empty.hex"));
  assert.equal(r.records.length, 1);
  assert.equal(buildSparseMap(r.records).byteCount, 0);
});

test("校验和损坏", () => expectCode(() => parseIntelHex(fx("bad_checksum.hex")), "E_CHECKSUM"));
test("截断行", () => expectCode(() => parseIntelHex(fx("truncated.hex")), "E_SYNTAX"));
test("类型专属长度错误", () => expectCode(() => parseIntelHex(fx("bad_type_length.hex")), "E_TYPE_LENGTH"));
test("单条数据跨越 16 位偏移边界", () => expectCode(() => parseIntelHex(fx("offset_overflow.hex")), "E_OFFSET_OVERFLOW"));
test("缺少结束记录", () => expectCode(() => parseIntelHex(fx("missing_eof.hex")), "E_EOF_MISSING"));
test("结束记录后仍有内容", () => expectCode(() => parseIntelHex(fx("after_eof.hex")), "E_AFTER_EOF"));
test("未知类型", () => expectCode(() => parseIntelHex(fx("unknown_type.hex")), "E_UNSUPPORTED_TYPE"));
test("行内空白被拒绝", () => expectCode(() => parseIntelHex(":01 000000FF\n:00000001FF\n"), "E_SYNTAX"));
test("小写 hex 与 LF 换行被允许", () => {
  const r = parseIntelHex(":020000000102fb\n:00000001ff\n");
  assert.equal(r.records.length, 2);
});

test("声明长度与实际不符", () =>
  expectCode(() => parseIntelHex(":040000000102FF\n:00000001FF\n"), "E_LENGTH"));

test("扩展地址状态：04 两段不相邻 + 切换 02，相同低位偏移不同绝对地址", () => {
  const r = parseIntelHex(fx("demo.hex"));
  const map = buildSparseMap(r.records);
  assert.deepEqual(map.segments.map((s) => [s.start, s.end]), [[0x100, 0x104], [0x10000, 0x10004], [0x10010, 0x10014]]);
  const seg = (a: number) => map.segments.find((s) => s.start === a)!;
  assert.deepEqual([...seg(0x100).data], [0xaa, 0xbb, 0xcc, 0xdd]);
  assert.deepEqual([...seg(0x10000).data], [0x11, 0x22, 0x33, 0x44]);
  assert.deepEqual([...seg(0x10010).data], [0x55, 0x66, 0x77, 0x88]);
});

test("逐字节来源：相同重叠合并且保留双方行号", () => {
  const map = buildSparseMap(parseIntelHex(fx("overlap_same.hex")).records);
  assert.equal(map.byteCount, 5);
  assert.deepEqual([...map.segments[0].data], [1, 2, 3, 4, 5]);
  const at = (a: number) => map.sources.filter((s) => s.address === a).map((s) => s.lineNo);
  assert.deepEqual(at(0x102), [1, 2]);
  assert.deepEqual(at(0x103), [1, 2]);
  assert.deepEqual(at(0x100), [1]);
});

test("冲突重叠整体失败并报告双方行号与值", () => {
  try {
    buildSparseMap(parseIntelHex(fx("overlap_conflict.hex")).records);
    assert.fail("应抛出冲突");
  } catch (e) {
    assert.ok(e instanceof HexError && e.code === "E_CONFLICT");
    assert.equal(e.details!.address, 0x103);
    assert.equal(e.details!.lineA, 1);
    assert.equal(e.details!.lineB, 2);
    assert.equal(e.details!.valueA, 0x04);
    assert.equal(e.details!.valueB, 0x99);
  }
});

test("启动元数据 03/05 保存且不产生数据字节；重复须一致", () => {
  const r = parseIntelHex(fx("metadata.hex"));
  assert.equal(r.startLinearAddress, 0x00010000);
  assert.deepEqual(r.startSegmentAddress, { cs: 0x1234, ip: 0xabcd });
  const map = buildSparseMap(r.records);
  assert.equal(map.byteCount, 2); // 只有 00 记录的字节
});

test("无扩展状态依赖的数据记录重排不改变结果", () => {
  const lines = fx("reorderable.hex").trim().split("\r\n");
  const dataLines = lines.filter((l) => l.slice(7, 9) === "00");
  const eof = lines[lines.length - 1];
  const base = buildSparseMap(parseIntelHex(lines.join("\n")).records);
  const perms = [
    [dataLines[1], dataLines[2], dataLines[0]],
    [dataLines[2], dataLines[0], dataLines[1]],
  ];
  for (const p of perms) {
    const m = buildSparseMap(parseIntelHex([...p, eof].join("\n")).records);
    assert.deepEqual(m.segments.map((s) => [s.start, [...s.data]]), base.segments.map((s) => [s.start, [...s.data]]));
  }
});

test("导出：空洞拒绝 / 填充并报告位置 / 长度与上限", () => {
  const map = buildSparseMap(parseIntelHex(fx("demo.hex")).records);
  expectCode(() => exportRange(map.segments, 0x10000, 0x10014), "E_HOLE");
  const r = exportRange(map.segments, 0x10000, 0x10014, { fill: 0xee });
  assert.equal(r.data.length, 0x14);
  assert.deepEqual([...r.data.subarray(0, 4)], [0x11, 0x22, 0x33, 0x44]);
  assert.deepEqual([...r.data.subarray(0x10)], [0x55, 0x66, 0x77, 0x88]);
  assert.equal(r.data[4], 0xee);
  assert.deepEqual(r.filledHoles, [{ start: 0x10004, end: 0x10010 }]);
  expectCode(() => exportRange(map.segments, 0, 2 * 1024 * 1024), "E_RANGE");
  expectCode(() => exportRange(map.segments, 10, 10), "E_RANGE");
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexmap-"));
  return { db: openDb(path.join(dir, "t.db")), dir };
}

test("导入失败不发布部分映射，旧数据仍可读；重复导入幂等；重启后查询原映射", () => {
  const { db, dir } = tmpDb();
  const ok = importHex(db, "demo.hex", fx("demo.hex"));
  assert.equal(ok.duplicate, false);

  // 冲突文件导入失败
  expectCode(() => importHex(db, "overlap_conflict.hex", fx("overlap_conflict.hex")), "E_CONFLICT");
  // 旧映射仍在
  const segs = listSegments(db, ok.id);
  assert.equal(segs.length, 3);
  assert.equal(lookupAddress(db, ok.id, 0x10000).value, 0x11);

  // 重复导入相同文件 -> 幂等
  const again = importHex(db, "demo.hex", fx("demo.hex"));
  assert.equal(again.duplicate, true);
  assert.equal(again.id, ok.id);

  // 模拟服务重启：关闭并重开同一数据库文件
  db.close();
  const db2 = openDb(path.join(dir, "t.db"));
  assert.equal(lookupAddress(db2, ok.id, 0x10010).value, 0x55);
  assert.deepEqual(lookupAddress(db2, ok.id, 0x102).sources.map((s) => s.lineNo), [5]);
  assert.equal(listSegments(db2, ok.id).length, 3);
  db2.close();
});

test("绝对地址不随旧映射变化：新文件独立建图", () => {
  const { db } = tmpDb();
  const a = importHex(db, "demo.hex", fx("demo.hex"));
  const b = importHex(db, "reorderable.hex", fx("reorderable.hex"));
  assert.notEqual(a.id, b.id);
  assert.equal(listSegments(db, a.id).length, 3); // 旧映射不变
  assert.equal(listSegments(db, b.id)[0].start, 0);
  db.close();
});
