import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { parseIntelHex } from "./parser.js";
import { buildSparseMap } from "./mapper.js";
import { HexError } from "./errors.js";
import path from "node:path";
import fs from "node:fs";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "hexmap.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      format_version TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      byte_count INTEGER NOT NULL,
      start_linear INTEGER,
      start_seg_cs INTEGER,
      start_seg_ip INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id),
      line_no INTEGER NOT NULL,
      raw TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      type INTEGER NOT NULL,
      base INTEGER,
      abs_start INTEGER
    );
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id),
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS byte_sources (
      import_id INTEGER NOT NULL REFERENCES imports(id),
      address INTEGER NOT NULL,
      value INTEGER NOT NULL,
      line_no INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_import ON records(import_id);
    CREATE INDEX IF NOT EXISTS idx_segments_import ON segments(import_id, start);
    CREATE INDEX IF NOT EXISTS idx_sources_import ON byte_sources(import_id, address);
  `);
  return db;
}

export interface ImportOutcome {
  id: number;
  duplicate: boolean;
  sha256: string;
  recordCount: number;
  byteCount: number;
}

// 导入：解析 + 建图 + 事务落库。任何失败不发布部分映射。
// 相同文件（sha256 相同）重复导入：幂等返回已有导入。
export function importHex(db: DatabaseSync, filename: string, content: string): ImportOutcome {
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const existing = db.prepare("SELECT id, record_count, byte_count FROM imports WHERE sha256 = ?").get(sha256) as
    | { id: number; record_count: number; byte_count: number } | undefined;
  if (existing) {
    return { id: existing.id, duplicate: true, sha256, recordCount: existing.record_count, byteCount: existing.byte_count };
  }

  const parsed = parseIntelHex(content);      // 解析失败则抛错，不落库
  const map = buildSparseMap(parsed.records); // 冲突则抛错，不落库

  db.exec("BEGIN");
  try {
    const info = db.prepare(
      `INSERT INTO imports (filename, sha256, format_version, record_count, byte_count, start_linear, start_seg_cs, start_seg_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      filename, sha256, parsed.formatVersion, parsed.records.length, map.byteCount,
      parsed.startLinearAddress,
      parsed.startSegmentAddress?.cs ?? null,
      parsed.startSegmentAddress?.ip ?? null,
      new Date().toISOString()
    );
    const importId = Number(info.lastInsertRowid);

    const insRec = db.prepare(
      "INSERT INTO records (import_id, line_no, raw, byte_count, offset, type, base, abs_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const r of parsed.records) {
      insRec.run(importId, r.lineNo, r.raw, r.byteCount, r.offset, r.type, r.base, r.absStart);
    }
    const insSeg = db.prepare("INSERT INTO segments (import_id, start, end, data) VALUES (?, ?, ?, ?)");
    for (const s of map.segments) {
      insSeg.run(importId, s.start, s.end, s.data);
    }
    const insSrc = db.prepare("INSERT INTO byte_sources (import_id, address, value, line_no) VALUES (?, ?, ?, ?)");
    for (const s of map.sources) {
      insSrc.run(importId, s.address, s.value, s.lineNo);
    }
    db.exec("COMMIT");
    return { id: importId, duplicate: false, sha256, recordCount: parsed.records.length, byteCount: map.byteCount };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getImportOrThrow(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new HexError("E_NOT_FOUND", `导入 #${id} 不存在`, { id });
  return row;
}

export function listSegments(db: DatabaseSync, importId: number) {
  getImportOrThrow(db, importId);
  const rows = db.prepare("SELECT start, end, data FROM segments WHERE import_id = ? ORDER BY start").all(importId) as
    { start: number; end: number; data: Buffer }[];
  return rows.map((r) => ({ start: r.start, end: r.end, data: Buffer.from(r.data) }));
}

export function lookupAddress(db: DatabaseSync, importId: number, address: number) {
  getImportOrThrow(db, importId);
  if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) {
    throw new HexError("E_VALIDATION", "地址必须是 0..0xFFFFFFFF 的整数");
  }
  const rows = db.prepare(
    "SELECT address, value, line_no FROM byte_sources WHERE import_id = ? AND address = ? ORDER BY line_no"
  ).all(importId, address) as { address: number; value: number; line_no: number }[];
  if (rows.length === 0) return { address, defined: false, sources: [] };
  return {
    address,
    defined: true,
    value: rows[0].value,
    sources: rows.map((r) => ({ lineNo: r.line_no, value: r.value })),
  };
}
