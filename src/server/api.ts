import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AppConfig, hex8, parseUint32 } from '../config';
import { HexStore } from '../db/database';
import { exportRange } from '../core/mapping';
import { ErrorBody, HexError } from '../core/errors';

interface Request {
  method: string;
  url: URL;
  body: Buffer;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  const body: ErrorBody = {
    error: { code: code as ErrorBody['error']['code'], message, details: details as Record<string, unknown> | undefined },
  };
  sendJson(res, status, body);
}

const STATUS_BY_CODE: Record<string, number> = {
  EMPTY_FILE: 400,
  BAD_LINE_FORMAT: 400,
  ODD_HEX_LENGTH: 400,
  INVALID_HEX_CHAR: 400,
  LINE_INLINE_WHITESPACE: 400,
  LINE_TOO_SHORT: 400,
  COUNT_MISMATCH: 400,
  CHECKSUM_FAILED: 422,
  UNSUPPORTED_RECORD_TYPE: 422,
  TYPE_LENGTH_MISMATCH: 422,
  CROSSES_64K_BOUNDARY: 422,
  ADDRESS_OVERFLOW: 422,
  MISSING_EOF: 422,
  RECORD_AFTER_EOF: 422,
  EMPTY_EOF_WITH_DATA: 422,
  CONFLICTING_DATA: 409,
  CONFLICTING_START_ADDRESS: 409,
  EXPORT_TOO_LARGE: 413,
  EXPORT_HAS_GAPS: 422,
  INVALID_RANGE: 400,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
};

export function createServer(config: AppConfig, store: HexStore): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const request: Request = { method: req.method ?? 'GET', url, body };
      await route(request, res, config, store);
    } catch (err) {
      if (err instanceof HexError) {
        sendError(res, STATUS_BY_CODE[err.code] ?? 400, err.code, err.message, err.details);
      } else if (err instanceof RangeError) {
        sendError(res, 400, 'BAD_REQUEST', err.message);
      } else {
        sendError(res, 500, 'INTERNAL', (err as Error).message);
      }
    }
  });
  return server;
}

async function route(req: Request, res: http.ServerResponse, config: AppConfig, store: HexStore): Promise<void> {
  const p = req.url.pathname;

  if (req.method === 'GET' && p === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && p === '/imports') {
    sendJson(res, 200, { imports: store.listImports() });
    return;
  }

  if (req.method === 'POST' && p === '/imports') {
    let parsed: { hexText?: unknown; fileName?: unknown };
    try {
      parsed = JSON.parse(req.body.toString('utf8') || '{}');
    } catch {
      throw new HexError('BAD_REQUEST', '请求体必须是 JSON');
    }
    if (typeof parsed.hexText !== 'string') {
      throw new HexError('BAD_REQUEST', '字段 hexText 必须为字符串（Intel HEX 文本）');
    }
    const fileName = typeof parsed.fileName === 'string' ? parsed.fileName : 'inline.hex';
    const summary = store.importHex(parsed.hexText.replace(/^﻿/, ''), fileName);
    sendJson(res, summary.reused ? 200 : 201, summary);
    return;
  }

  const importMatch = p.match(/^\/imports\/(\d+)\/(records|segments|bytes|source)$/);
  if (importMatch) {
    const id = Number(importMatch[1]);
    const action = importMatch[2];

    if (action === 'records') {
      sendJson(res, 200, { importId: id, records: store.getRecords(id) });
      return;
    }
    if (action === 'segments') {
      const stored = store.getImport(id);
      sendJson(res, 200, {
        importId: id,
        segments: stored.segments.map((s) => ({
          start: s.start,
          startHex: hex8(s.start),
          end: s.end,
          endHex: hex8(s.end),
          length: s.length,
        })),
        startAddresses: stored.startAddresses,
      });
      return;
    }
    if (action === 'bytes') {
      const start = req.url.searchParams.has('start') ? parseUint32(req.url.searchParams.get('start')!, 'start') : undefined;
      const end = req.url.searchParams.has('end') ? parseUint32(req.url.searchParams.get('end')!, 'end') : undefined;
      if (start !== undefined && end !== undefined && start > end) throw new HexError('INVALID_RANGE', 'start 不能大于 end');
      const bytes = store.getBytes(id, start, end);
      sendJson(res, 200, {
        importId: id,
        bytes: bytes.map((b) => ({
          address: b.address,
          addressHex: hex8(b.address),
          value: b.value,
          valueHex: b.value.toString(16).padStart(2, '0').toUpperCase(),
          sourceLines: b.sources,
        })),
      });
      return;
    }
    if (action === 'source') {
      if (!req.url.searchParams.has('address')) {
        throw new HexError('BAD_REQUEST', '缺少 query 参数 address');
      }
      const address = parseUint32(req.url.searchParams.get('address')!, 'address');
      const hit = store.findSource(id, address);
      sendJson(res, 200, {
        importId: id,
        address: hit.address,
        addressHex: hex8(hit.address),
        value: hit.value,
        valueHex: hit.value.toString(16).padStart(2, '0').toUpperCase(),
        sourceLines: hit.lines,
      });
      return;
    }
  }

  const exportMatch = p.match(/^\/imports\/(\d+)\/export$/);
  if (exportMatch && req.method === 'POST') {
    const id = Number(exportMatch[1]);
    let parsed: {
      start?: unknown;
      end?: unknown;
      gapPolicy?: unknown;
      fillByte?: unknown;
    };
    try {
      parsed = JSON.parse(req.body.toString('utf8') || '{}');
    } catch {
      throw new HexError('BAD_REQUEST', '请求体必须是 JSON');
    }
    if (typeof parsed.start !== 'string' || typeof parsed.end !== 'string') {
      throw new HexError('BAD_REQUEST', 'start 与 end 必填，为十六进制（可带 0x）或十进制字符串');
    }
    const start = parseUint32(parsed.start as string, 'start');
    const end = parseUint32(parsed.end as string, 'end');
    const gapPolicy = parsed.gapPolicy === 'fill' ? 'fill' : 'reject';
    let fillByte: number | undefined;
    if (gapPolicy === 'fill') {
      if (typeof parsed.fillByte !== 'string' && typeof parsed.fillByte !== 'number') {
        throw new HexError('BAD_REQUEST', 'gapPolicy=fill 时必须提供 fillByte（0..255）');
      }
      fillByte = parseUint32(String(parsed.fillByte), 'fillByte');
      if (fillByte > 0xff) throw new HexError('BAD_REQUEST', 'fillByte 必须在 0..255 范围内', { fillByte });
    }

    const mapped = store.getBytes(id);
    const result = exportRange(mapped, { start, end, maxBytes: config.maxExportBytes, gapPolicy, fillByte });
    const exportsDir = path.join(config.dataDir, 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const fileName = `import_${id}_${start.toString(16).padStart(8, '0')}_${end.toString(16).padStart(8, '0')}.bin`;
    fs.writeFileSync(path.join(exportsDir, fileName), result.data);

    sendJson(res, 200, {
      importId: id,
      file: path.join('data', 'exports', fileName),
      start,
      startHex: hex8(start),
      end,
      endHex: hex8(end),
      length: result.length,
      filledBytes: result.filledBytes,
      filledGaps: result.filledGaps.map((g) => ({ ...g, startHex: hex8(g.start), endHex: hex8(g.end) })),
    });
    return;
  }

  sendError(res, 404, 'NOT_FOUND', `无此路由：${req.method} ${p}`);
}

export async function startServer(config: AppConfig, store: HexStore): Promise<http.Server> {
  const server = createServer(config, store);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, () => resolve()));
  return server;
}

export function boundPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}
