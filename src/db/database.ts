import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HexError } from '../core/errors';
import { PARSER_FORMAT_VERSION, parseIntelHex, StartAddress } from '../core/parser';
import { buildSparseMap, MappedByte, Segment } from '../core/mapping';

export interface ImportSummary {
  id: number;
  sha256: string;
  fileName: string;
  recordCount: number;
  byteCount: number;
  segmentCount: number;
  importedAt: string;
  reused: boolean;
}

export interface StoredImport extends ImportSummary {
  rawText: string;
  startAddresses: (StartAddress & { consistent: boolean })[];
  segments: StoredSegment[];
}

export interface StoredSegment {
  start: number;
  end: number;
  length: number;
}

export interface SourceHit {
  importId: number;
  address: number;
  value: number;
  lines: number[];
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  line_no INTEGER NOT NULL,
  rec_type INTEGER NOT NULL,
  offset16 INTEGER NOT NULL,
  data_hex TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS start_addresses (
  import_id INTEGER NOT NULL REFERENCES imports(id),
  kind INTEGER NOT NULL,
  address INTEGER NOT NULL,
  line_no INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bytes_map (
  import_id INTEGER NOT NULL REFERENCES imports(id),
  address INTEGER NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (import_id, address)
);
CREATE TABLE IF NOT EXISTS byte_sources (
  import_id INTEGER NOT NULL REFERENCES imports(id),
  address INTEGER NOT NULL,
  line_no INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  import_id INTEGER NOT NULL REFERENCES imports(id),
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  length INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_import ON records(import_id, line_no);
CREATE INDEX IF NOT EXISTS idx_bytes_import_addr ON bytes_map(import_id, address);
CREATE INDEX IF NOT EXISTS idx_sources_import_addr ON byte_sources(import_id, address);
CREATE INDEX IF NOT EXISTS idx_segments_import ON segments(import_id, start);
`;

export class HexStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'ihex.sqlite'));
    this.db.exec(SCHEMA);
    this.db
      .prepare(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('parser_format_version', ?)`)
      .run(String(PARSER_FORMAT_VERSION));
  }

  close(): void {
    this.db.close();
  }

  /** 导入 HEX 文本。相同 sha256 的文件重复导入固定返回旧映射，不做任何修改。 */
  importHex(rawText: string, fileName: string): ImportSummary {
    const sha256 = createHash('sha256').update(rawText, 'utf8').digest('hex');
    const existing = this.getSummaryBySha(sha256);
    if (existing) return { ...existing, reused: true };

    // 在事务外完成解析/构建：若失败则绝不写入任何映射（不发布部分映射）。
    const parsed = parseIntelHex(rawText, sha256);
    const built = buildSparseMap(parsed.bytes);
    this.assertConsistentStartAddresses(parsed.startAddresses);

    const importedAt = new Date().toISOString();
    const insertImport = this.db.prepare(
      `INSERT INTO imports(sha256, file_name, raw_text, format_version, record_count, byte_count, segment_count, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRecord = this.db.prepare(
      `INSERT INTO records(import_id, line_no, rec_type, offset16, data_hex, raw) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertStart = this.db.prepare(
      `INSERT INTO start_addresses(import_id, kind, address, line_no) VALUES (?, ?, ?, ?)`,
    );
    const insertByte = this.db.prepare(
      `INSERT INTO bytes_map(import_id, address, value) VALUES (?, ?, ?)`,
    );
    const insertSource = this.db.prepare(
      `INSERT INTO byte_sources(import_id, address, line_no) VALUES (?, ?, ?)`,
    );
    const insertSeg = this.db.prepare(
      `INSERT INTO segments(import_id, start, end, length) VALUES (?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const info = insertImport.run(
        sha256,
        fileName,
        rawText,
        PARSER_FORMAT_VERSION,
        parsed.records.length,
        built.bytes.length,
        built.segments.length,
        importedAt,
      );
      const importId = Number(info.lastInsertRowid);

      for (const rec of parsed.records) {
        insertRecord.run(
          importId,
          rec.line,
          rec.type,
          rec.offset,
          rec.data.toString('hex').toUpperCase(),
          rec.raw,
        );
      }
      for (const sa of parsed.startAddresses) {
        insertStart.run(importId, sa.kind, sa.address, sa.line);
      }
      for (const mb of built.bytes) {
        insertByte.run(importId, mb.address, mb.value);
        for (const lineNo of mb.sources) insertSource.run(importId, mb.address, lineNo);
      }
      for (const seg of built.segments) {
        insertSeg.run(importId, seg.start, seg.end, seg.length);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      id: Number(this.db.prepare(`SELECT id FROM imports WHERE sha256 = ?`).get(sha256)!.id),
      sha256,
      fileName,
      recordCount: parsed.records.length,
      byteCount: built.bytes.length,
      segmentCount: built.segments.length,
      importedAt,
      reused: false,
    };
  }

  private assertConsistentStartAddresses(starts: StartAddress[]): void {
    const byKind = new Map<number, StartAddress[]>();
    for (const sa of starts) {
      const list = byKind.get(sa.kind) ?? [];
      list.push(sa);
      byKind.set(sa.kind, list);
    }
    for (const [kind, list] of byKind) {
      const first = list[0];
      for (const other of list.slice(1)) {
        if (other.address !== first.address) {
          throw new HexError(
            'CONFLICTING_START_ADDRESS',
            `类型 0${kind.toString(16)} 启动地址元数据不一致：第 ${first.line} 行=0x${first.address
              .toString(16)
              .toUpperCase()
              .padStart(8, '0')}，第 ${other.line} 行=0x${other.address
              .toString(16)
              .toUpperCase()
              .padStart(8, '0')}`,
            { kind, firstLine: first.line, conflictLine: other.line },
          );
        }
      }
    }
  }

  listImports(): ImportSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, sha256, file_name, record_count, byte_count, segment_count, imported_at
         FROM imports ORDER BY id`,
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      sha256: r.sha256,
      fileName: r.file_name,
      recordCount: r.record_count,
      byteCount: r.byte_count,
      segmentCount: r.segment_count,
      importedAt: r.imported_at,
      reused: false,
    }));
  }

  private getSummaryBySha(sha256: string): Omit<ImportSummary, 'reused'> | undefined {
    const r = this.db
      .prepare(
        `SELECT id, sha256, file_name, record_count, byte_count, segment_count, imported_at
         FROM imports WHERE sha256 = ?`,
      )
      .get(sha256) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      sha256: r.sha256,
      fileName: r.file_name,
      recordCount: r.record_count,
      byteCount: r.byte_count,
      segmentCount: r.segment_count,
      importedAt: r.imported_at,
    };
  }

  getImport(importId: number): StoredImport {
    const head = this.db.prepare(`SELECT * FROM imports WHERE id = ?`).get(importId) as any;
    if (!head) throw new HexError('NOT_FOUND', `导入 id=${importId} 不存在`, { importId });
    const segments = (this.db
      .prepare(`SELECT start, end, length FROM segments WHERE import_id = ? ORDER BY start`)
      .all(importId) as any[]).map((s) => ({ start: s.start, end: s.end, length: s.length }));
    const startAddresses = (this.db
      .prepare(`SELECT kind, address, line_no FROM start_addresses WHERE import_id = ? ORDER BY line_no`)
      .all(importId) as any[]).map((s) => ({
      kind: s.kind as 0x03 | 0x05,
      address: s.address,
      line: s.line_no,
      consistent: true,
    }));
    return {
      id: head.id,
      sha256: head.sha256,
      fileName: head.file_name,
      rawText: head.raw_text,
      formatVersion: head.format_version,
      recordCount: head.record_count,
      byteCount: head.byte_count,
      segmentCount: head.segment_count,
      importedAt: head.imported_at,
      reused: false,
      startAddresses,
      segments,
    } as StoredImport;
  }

  getRecords(importId: number): { line: number; type: number; offset: number; dataHex: string; raw: string }[] {
    this.requireImport(importId);
    const rows = this.db
      .prepare(`SELECT line_no, rec_type, offset16, data_hex, raw FROM records WHERE import_id = ? ORDER BY line_no`)
      .all(importId) as any[];
    return rows.map((r) => ({ line: r.line_no, type: r.rec_type, offset: r.offset16, dataHex: r.data_hex, raw: r.raw }));
  }

  getBytes(importId: number, start?: number, end?: number): MappedByte[] {
    this.requireImport(importId);
    const byteRows = this.db
      .prepare(
        `SELECT address, value FROM bytes_map WHERE import_id = ?
         ${start !== undefined ? 'AND address >= ?' : ''}
         ${end !== undefined ? 'AND address <= ?' : ''}
         ORDER BY address`,
      )
      .all(importId, ...(start !== undefined ? [start] : []), ...(end !== undefined ? [end] : [])) as any[];
    if (byteRows.length === 0) return [];
    const sourceRows = this.db
      .prepare(
        `SELECT address, line_no FROM byte_sources WHERE import_id = ?
         ${start !== undefined ? 'AND address >= ?' : ''}
         ${end !== undefined ? 'AND address <= ?' : ''}
         ORDER BY address, line_no`,
      )
      .all(importId, ...(start !== undefined ? [start] : []), ...(end !== undefined ? [end] : [])) as any[];
    const sourcesByAddr = new Map<number, number[]>();
    for (const sr of sourceRows) {
      const list = sourcesByAddr.get(sr.address) ?? [];
      list.push(sr.line_no);
      sourcesByAddr.set(sr.address, list);
    }
    return byteRows.map((r) => ({
      address: r.address,
      value: r.value,
      sources: sourcesByAddr.get(r.address) ?? [],
    }));
  }

  getSegments(importId: number): Segment[] {
    this.requireImport(importId);
    const rows = this.db
      .prepare(`SELECT start, end, length FROM segments WHERE import_id = ? ORDER BY start`)
      .all(importId) as any[];
    return rows.map((r) => ({ start: r.start, end: r.end, length: r.length, bytes: [] }));
  }

  findSource(importId: number, address: number): SourceHit {
    this.requireImport(importId);
    const row = this.db
      .prepare(`SELECT value FROM bytes_map WHERE import_id = ? AND address = ?`)
      .get(importId, address) as any;
    if (!row) {
      throw new HexError('NOT_FOUND', `地址 0x${address.toString(16).toUpperCase().padStart(8, '0')} 没有已定义字节`, {
        importId,
        address,
      });
    }
    const lines = (this.db
      .prepare(`SELECT line_no FROM byte_sources WHERE import_id = ? AND address = ? ORDER BY line_no`)
      .all(importId, address) as any[]).map((r) => r.line_no);
    return { importId, address, value: row.value, lines };
  }

  private requireImport(importId: number): void {
    const row = this.db.prepare(`SELECT id FROM imports WHERE id = ?`).get(importId);
    if (!row) throw new HexError('NOT_FOUND', `导入 id=${importId} 不存在`, { importId });
  }
}
