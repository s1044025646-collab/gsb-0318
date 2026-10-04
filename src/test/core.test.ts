import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseIntelHex } from '../core/parser';
import { buildSparseMap, coverage, exportRange } from '../core/mapping';
import { HexError } from '../core/errors';

const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

function mapOf(text: string) {
  const parsed = parseIntelHex(text, 'test-sha');
  return { parsed, built: buildSparseMap(parsed.bytes) };
}

test('demo: 04 后两段不相邻数据，再切换 02，低偏移指向不同绝对地址', () => {
  const { built, parsed } = mapOf(fixture('demo.hex'));
  const expected: Array<[number, number]> = [
    [0x10000, 0xde],
    [0x10001, 0xad],
    [0x10002, 0xbe],
    [0x10003, 0xef],
    [0x10100, 0x12],
    [0x10101, 0x34],
    [0xf0000, 0xaa],
    [0xf0001, 0xbb],
  ];
  assert.equal(built.bytes.length, expected.length);
  for (const [i, [addr, val]] of expected.entries()) {
    assert.equal(built.bytes[i].address, addr, `地址不匹配 @${i}`);
    assert.equal(built.bytes[i].value, val, `值不匹配 @${i}`);
  }
  // 三个互不相邻区间（空洞保持空洞，不补零）。
  assert.deepEqual(
    built.segments.map((s) => [s.start, s.end]),
    [
      [0x10000, 0x10003],
      [0x10100, 0x10101],
      [0xf0000, 0xf0001],
    ],
  );
  // 关键：同样低偏移 0x0000，04 基址与 02 基址给出不同绝对地址。
  assert.equal(built.bytes[0].address, 0x10000);
  assert.equal(built.bytes[6].address, 0xf0000);
  // 03 与 05 分别保留为元数据，不产生数据字节。
  assert.equal(parsed.startAddresses.length, 2);
  assert.deepEqual(
    parsed.startAddresses.map((s) => [s.kind, s.address]),
    [
      [0x03, 0x1234],
      [0x05, 0x5678],
    ],
  );
});

test('空数据 + 结束记录得到空映射', () => {
  const { built } = mapOf(fixture('empty_data.hex'));
  assert.equal(built.bytes.length, 0);
  assert.equal(built.segments.length, 0);
});

test('逐字节来源行号正确', () => {
  const { built } = mapOf(fixture('demo.hex'));
  const at = (addr: number) => built.bytes.find((b) => b.address === addr)!;
  assert.deepEqual(at(0x10000).sources, [2]);
  assert.deepEqual(at(0x10101).sources, [3]);
  assert.deepEqual(at(0xf0001).sources, [5]);
});

test('无扩展状态依赖时数据记录重排不改变映射', () => {
  const a = mapOf(fixture('demo.hex')).built.bytes.filter(
    (b) => b.address < 0xf0000,
  );
  const b = mapOf(fixture('reorder.hex')).built.bytes;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].address, b[i].address);
    assert.equal(a[i].value, b[i].value);
  }
});

test('相同重叠：合并字节且保留两条来源', () => {
  const { built } = mapOf(fixture('overlap_same.hex'));
  assert.deepEqual(
    built.bytes.map((b) => [b.address, b.value]),
    [
      [0x10, 0x11],
      [0x11, 0x22],
    ],
  );
  assert.deepEqual(
    built.bytes.find((b) => b.address === 0x11)!.sources,
    [1, 2],
  );
  assert.equal(built.segments.length, 1);
});

test('冲突重叠：报告绝对地址、双方行号与冲突值，且不覆盖', () => {
  assert.throws(
    () => mapOf(fixture('overlap_conflict.hex')),
    (err: unknown) => {
      assert.ok(err instanceof HexError);
      assert.equal(err.code, 'CONFLICTING_DATA');
      assert.equal(err.details!.address, 0x11);
      assert.equal(err.details!.firstLine, 1);
      assert.equal(err.details!.firstValue, 0x22);
      assert.equal(err.details!.conflictLine, 2);
      assert.equal(err.details!.conflictValue, 0x33);
      return true;
    },
  );
});

const badCases: Array<[string, string]> = [
  ['bad_checksum.hex', 'CHECKSUM_FAILED'],
  ['truncated.hex', 'COUNT_MISMATCH'],
  ['bad_type_length.hex', 'TYPE_LENGTH_MISMATCH'],
  ['overflow.hex', 'ADDRESS_OVERFLOW'],
  ['cross_64k.hex', 'CROSSES_64K_BOUNDARY'],
  ['missing_eof.hex', 'MISSING_EOF'],
  ['after_eof.hex', 'RECORD_AFTER_EOF'],
  ['unknown_type.hex', 'UNSUPPORTED_RECORD_TYPE'],
];

for (const [file, code] of badCases) {
  test(`坏夹具 ${file} => ${code}`, () => {
    assert.throws(
      () => mapOf(fixture(file)),
      (err: unknown) => err instanceof HexError && err.code === code,
    );
  });
}

test('行内空白被拒绝', () => {
  assert.throws(
    () => mapOf(':04 0000 00 DEADBEEFC4\n:00000001FF\n'),
    (err: unknown) => err instanceof HexError && err.code === 'LINE_INLINE_WHITESPACE',
  );
});

test('小写十六进制与 CRLF 被接受', () => {
  const { built } = mapOf(':04000000deadbeefc4\r\n:00000001FF\r\n');
  assert.equal(built.bytes.length, 4);
  assert.equal(built.bytes[0].value, 0xde);
});

test('空洞查询与填充导出：报告实际填充位置与长度', () => {
  const { built } = mapOf(fixture('demo.hex'));
  const cov = coverage(built.segments, 0x10000, 0x10101);
  assert.equal(cov.coveredBytes, 6);
  assert.deepEqual(cov.gaps, [{ start: 0x10004, end: 0x100ff, length: 0xfc }]);

  assert.throws(
    () => exportRange(built.bytes, { start: 0x10000, end: 0x10101, maxBytes: 4096, gapPolicy: 'reject' }),
    (err: unknown) => err instanceof HexError && err.code === 'EXPORT_HAS_GAPS',
  );

  const filled = exportRange(built.bytes, {
    start: 0x10000,
    end: 0x10101,
    maxBytes: 4096,
    gapPolicy: 'fill',
    fillByte: 0xff,
  });
  assert.equal(filled.length, 258);
  assert.equal(filled.filledBytes, 252);
  assert.deepEqual(filled.filledGaps, [{ start: 0x10004, end: 0x100ff, length: 0xfc }]);
  assert.equal(filled.data[0], 0xde);
  assert.equal(filled.data[4], 0xff);
  assert.equal(filled.data[257], 0x34);

  assert.throws(
    () => exportRange(built.bytes, { start: 0, end: 2, maxBytes: 2, gapPolicy: 'fill', fillByte: 0 }),
    (err: unknown) => err instanceof HexError && err.code === 'EXPORT_TOO_LARGE',
  );
});
