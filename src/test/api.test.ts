import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppConfig } from '../config';
import { HexStore } from '../db/database';
import { boundPort, startServer } from '../server/api';
import { Server } from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihex-api-'));
const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures');

const config: AppConfig = { dataDir, port: 0, host: '127.0.0.1', maxExportBytes: 4096 };
let store: HexStore;
let server: Server;
let baseUrl: string;

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  store = new HexStore(dataDir);
  server = await startServer(config, store);
  baseUrl = `http://127.0.0.1:${boundPort(server)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('健康检查与导入、查询、导出全流程', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);

  const hexText = fs.readFileSync(path.join(fixturesDir, 'demo.hex'), 'utf8');
  const imp = await call('POST', '/imports', { hexText, fileName: 'demo.hex' });
  assert.equal(imp.status, 201);
  const id = imp.json.id;

  const again = await call('POST', '/imports', { hexText });
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true);

  const records = await call('GET', `/imports/${id}/records`);
  assert.equal(records.json.records.length, 8);
  assert.equal(records.json.records[0].type, 4);

  const segments = await call('GET', `/imports/${id}/segments`);
  assert.equal(segments.json.segments.length, 3);
  assert.equal(segments.json.segments[2].startHex, '0x000F0000');

  const source = await call('GET', `/imports/${id}/source?address=0xF0001`);
  assert.equal(source.json.valueHex, 'BB');
  assert.deepEqual(source.json.sourceLines, [5]);

  const bytes = await call('GET', `/imports/${id}/bytes?start=0x10000&end=0x10001`);
  assert.equal(bytes.json.bytes.length, 2);

  const rejectExport = await call('POST', `/imports/${id}/export`, {
    start: '0x10000',
    end: '0x10101',
    gapPolicy: 'reject',
  });
  assert.equal(rejectExport.status, 422);
  assert.equal(rejectExport.json.error.code, 'EXPORT_HAS_GAPS');

  const filled = await call('POST', `/imports/${id}/export`, {
    start: '0x10000',
    end: '0x10101',
    gapPolicy: 'fill',
    fillByte: '0xFF',
  });
  assert.equal(filled.status, 200);
  assert.equal(filled.json.length, 258);
  assert.equal(filled.json.filledBytes, 252);
  assert.equal(filled.json.filledGaps[0].startHex, '0x00010004');
  const exportedFile = path.join(dataDir, 'exports', path.basename(filled.json.file));
  const exported = fs.readFileSync(exportedFile);
  assert.equal(exported.length, 258);
  assert.equal(exported[0], 0xde);
  assert.equal(exported[4], 0xff);
});

test('冲突导入返回 409 且给出地址、行号、值', async () => {
  const hexText = fs.readFileSync(path.join(fixturesDir, 'overlap_conflict.hex'), 'utf8');
  const res = await call('POST', '/imports', { hexText });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'CONFLICTING_DATA');
  assert.equal(res.json.error.details.address, 0x11);
});

test('超过导出上限返回 413；非法区间返回 400', async () => {
  const hexText = fs.readFileSync(path.join(fixturesDir, 'demo.hex'), 'utf8');
  const id = (await call('POST', '/imports', { hexText, fileName: 'x.hex' })).json.id;
  const tooBig = await call('POST', `/imports/${id}/export`, {
    start: '0x0',
    end: '0xFFFF',
    gapPolicy: 'fill',
    fillByte: '0',
  });
  assert.equal(tooBig.status, 413);

  const badRange = await call('POST', `/imports/${id}/export`, {
    start: '0x100',
    end: '0x10',
    gapPolicy: 'reject',
  });
  assert.equal(badRange.status, 400);
});

test('未知导入返回 404', async () => {
  const res = await call('GET', '/imports/999/segments');
  assert.equal(res.status, 404);
});
