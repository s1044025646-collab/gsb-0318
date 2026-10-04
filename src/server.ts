import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, importHex, listSegments, lookupAddress, getImportOrThrow, DATA_DIR } from "./db.js";
import { exportRange, DEFAULT_MAX_EXPORT } from "./mapper.js";
import { HexError } from "./errors.js";

const FIXTURES_DIR = path.resolve(process.cwd(), "fixtures");

function parseNum(v: string | null, name: string): number {
  if (v === null || v.trim() === "") throw new HexError("E_VALIDATION", `缺少参数 ${name}`);
  const n = v.toLowerCase().startsWith("0x") ? parseInt(v, 16) : Number(v);
  if (!Number.isInteger(n) || Number.isNaN(n)) throw new HexError("E_VALIDATION", `参数 ${name} 不是合法整数：${v}`);
  return n;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}

function sendError(res: http.ServerResponse, err: unknown) {
  if (err instanceof HexError) {
    const status = err.code === "E_NOT_FOUND" ? 404 : err.code.startsWith("E_") ? 400 : 500;
    sendJson(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
  } else {
    sendJson(res, 500, { error: { code: "E_INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function createServer(db: DatabaseSync, opts: { maxExport?: number } = {}) {
  const maxExport = opts.maxExport ?? DEFAULT_MAX_EXPORT;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["api","imports",...]

      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, maxExport });
      }

      if (req.method === "POST" && url.pathname === "/api/imports") {
        const body = JSON.parse((await readBody(req)) || "{}");
        let filename: string, content: string;
        if (typeof body.content === "string") {
          filename = typeof body.filename === "string" ? body.filename : "<inline>";
          content = body.content;
        } else if (typeof body.filename === "string") {
          // 只允许读取项目 fixtures 目录内的文本夹具，不扫描系统文件
          const p = path.resolve(FIXTURES_DIR, path.basename(body.filename));
          if (!p.startsWith(FIXTURES_DIR + path.sep) || !fs.existsSync(p)) {
            throw new HexError("E_NOT_FOUND", `夹具不存在：${body.filename}（仅允许 fixtures 目录）`);
          }
          filename = path.basename(body.filename);
          content = fs.readFileSync(p, "utf8");
        } else {
          throw new HexError("E_VALIDATION", "请求体需包含 filename 或 content");
        }
        const outcome = importHex(db, filename, content);
        return sendJson(res, outcome.duplicate ? 200 : 201, outcome);
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "imports" && parts.length === 2) {
        const rows = db.prepare("SELECT id, filename, sha256, format_version, record_count, byte_count, start_linear, start_seg_cs, start_seg_ip, created_at FROM imports ORDER BY id").all();
        return sendJson(res, 200, rows);
      }

      if (parts[0] === "api" && parts[1] === "imports" && parts.length >= 3) {
        const id = parseNum(parts[2], "id");
        const sub = parts[3];

        if (req.method === "GET" && parts.length === 3) {
          return sendJson(res, 200, getImportOrThrow(db, id));
        }
        if (req.method === "GET" && sub === "records") {
          getImportOrThrow(db, id);
          const rows = db.prepare("SELECT line_no, raw, byte_count, offset, type, base, abs_start FROM records WHERE import_id = ? ORDER BY line_no").all(id);
          return sendJson(res, 200, rows);
        }
        if (req.method === "GET" && sub === "segments") {
          const segs = listSegments(db, id).map((s) => ({
            start: s.start, end: s.end, length: s.end - s.start,
            startHex: "0x" + s.start.toString(16).toUpperCase().padStart(8, "0"),
            endHex: "0x" + s.end.toString(16).toUpperCase().padStart(8, "0"),
            dataHex: s.data.toString("hex").toUpperCase(),
          }));
          return sendJson(res, 200, segs);
        }
        if (req.method === "GET" && sub === "lookup") {
          const addr = parseNum(url.searchParams.get("addr"), "addr");
          return sendJson(res, 200, lookupAddress(db, id, addr));
        }
        if (req.method === "GET" && sub === "export") {
          const start = parseNum(url.searchParams.get("start"), "start");
          const end = parseNum(url.searchParams.get("end"), "end");
          const fillParam = url.searchParams.get("fill");
          const fill = fillParam === null || fillParam === "reject" ? undefined : parseNum(fillParam, "fill");
          const segs = listSegments(db, id);
          const result = exportRange(segs, start, end, { fill, maxSize: maxExport });
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": result.data.length,
            "X-Filled-Holes": JSON.stringify(result.filledHoles),
          });
          return res.end(result.data);
        }
      }

      throw new HexError("E_NOT_FOUND", `未知路由：${req.method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(port?: number): Promise<{ port: number; close: () => void }> {
  const db = openDb();
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port: p, close: () => { server.close(); db.close(); } });
    });
  });
}

export { DATA_DIR };
