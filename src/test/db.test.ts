import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HexStore } from '../db/database';
import { HexError } from '../core/errors';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihex-test-'));
const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

let store: HexStore;

before(() => {
  store = new HexStore(dataDir);
});
after(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('导入 demo 成功并可逐字节查询来源', () => {
  const summary = store.importHex(fixture('demo.hex'), 'demo.hex');
  assert.equal(summary.reused, false);
  assert.equal(summary.byteCount, 8);
  assert.equal(summary.segmentCount, 3);

  const hit = store.findSource(summary.id, 0xf0001);
  assert.equal(hit.value, 0xbb);
  assert.deepEqual(hit.lines, [5]);
});

test('冲突导入失败且不发布部分映射', () => {
  const beforeCount = store.listImports().length;
  assert.throws(
    () => store.importHex(fixture('overlap_conflict.hex'), 'conflict.hex'),
    (err: unknown) => err instanceof HexError && err.code === 'CONFLICTING_DATA',
  );
  assert.equal(store.listImports().length, beforeCount);
});

test('其他坏文件也不会留下导入记录', () => {
  for (const file of ['bad_checksum.hex', 'overflow.hex', 'missing_eof.hex', 'unknown_type.hex']) {
    const n = store.listImports().length;
    assert.throws(() => store.importHex(fixture(file), file));
    assert.equal(store.listImports().length, n, `${file} 不应留下导入`);
  }
});

test('导入失败后旧映射仍可读取', () => {
  const [first] = store.listImports();
  const bytes = store.getBytes(first.id);
  assert.equal(bytes.length, 8);
  assert.equal(bytes[6].address, 0xf0000);
});

test('相同文件重复导入固定幂等，旧映射不随调用变化', () => {
  const first = store.importHex(fixture('demo.hex'), 'demo.hex');
  assert.equal(first.reused, true);
  const second = store.importHex(fixture('demo.hex'), 'other-name.hex');
  assert.equal(second.id, first.id);
  assert.equal(second.fileName, 'demo.hex');
  assert.equal(store.listImports().filter((i) => i.sha256 === first.sha256).length, 1);
});

test('相同重叠保留多来源行号', () => {
  const summary = store.importHex(fixture('overlap_same.hex'), 'same.hex');
  const hit = store.findSource(summary.id, 0x11);
  assert.equal(hit.value, 0x22);
  assert.deepEqual(hit.lines, [1, 2]);
});

test('重复 03 启动元数据一致时可导入；不一致被拒绝', () => {
  const ok = ':0400000300001234B3\n:0400000300001234B3\n:00000001FF\n';
  const summary = store.importHex(ok, 'dup-ok.hex');
  const info = store.getImport(summary.id);
  assert.equal(info.startAddresses.length, 2);

  const bad = ':0400000300001234B3\n:0400000300001235B2\n:00000001FF\n';
  assert.throws(
    () => store.importHex(bad, 'dup-bad.hex'),
    (err: unknown) => err instanceof HexError && err.code === 'CONFLICTING_START_ADDRESS',
  );
});

test('重新打开数据库（模拟服务重启）后原映射仍可查询', () => {
  store.close();
  const reopened = new HexStore(dataDir);
  const [first] = reopened.listImports();
  assert.equal(first.fileName, 'demo.hex');
  const seg = reopened.getSegments(first.id);
  assert.deepEqual(
    seg.map((s) => [s.start, s.end]),
    [
      [0x10000, 0x10003],
      [0x10100, 0x10101],
      [0xf0000, 0xf0001],
    ],
  );
  const records = reopened.getRecords(first.id);
  assert.equal(records.length, 8);
  assert.equal(records[0].type, 0x04);
  store = reopened;
});
