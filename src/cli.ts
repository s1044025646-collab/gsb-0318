import fs from "node:fs";
import path from "node:path";
import { openDb, importHex, listSegments, lookupAddress, getImportOrThrow, DB_PATH } from "./db.js";
import { exportRange } from "./mapper.js";
import { startServer } from "./server.js";
import { HexError } from "./errors.js";

const hex8 = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(8, "0");

function parseNumArg(v: string, name: string): number {
  const n = v.toLowerCase().startsWith("0x") ? parseInt(v, 16) : Number(v);
  if (!Number.isInteger(n) || Number.isNaN(n)) throw new HexError("E_VALIDATION", `参数 ${name} 非法：${v}`);
  return n;
}

function usage() {
  console.log(`用法：
  node dist/src/cli.js serve [--port N]            启动 API 服务（默认自动选空闲端口）
  node dist/src/cli.js import <文件>               导入 Intel HEX 文件
  node dist/src/cli.js imports                     列出全部导入
  node dist/src/cli.js records <导入ID>            查询记录
  node dist/src/cli.js segments <导入ID>           查看地址段
  node dist/src/cli.js lookup <导入ID> <地址>      定位某地址来源
  node dist/src/cli.js export <导入ID> <起始> <结束> <输出文件> [--fill 0xNN | --reject]
  node dist/src/cli.js demo                        运行扩展地址演示
数据库：${DB_PATH}`);
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "serve": {
      const pi = args.indexOf("--port");
      const port = pi >= 0 ? parseNumArg(args[pi + 1], "port") : undefined;
      const { port: p } = await startServer(port);
      console.log(`API 服务已启动：http://127.0.0.1:${p}`);
      return; // 保持进程存活
    }
    case "import": {
      const file = args[0];
      if (!file) throw new HexError("E_VALIDATION", "缺少文件路径");
      const content = fs.readFileSync(file, "utf8");
      const db = openDb();
      const r = importHex(db, path.basename(file), content);
      console.log(r.duplicate ? `相同文件已存在，复用导入 #${r.id}` : `导入成功：#${r.id}，记录 ${r.recordCount} 条，映射 ${r.byteCount} 字节`);
      db.close();
      return;
    }
    case "imports": {
      const db = openDb();
      console.log(JSON.stringify(db.prepare("SELECT id, filename, sha256, format_version, record_count, byte_count, created_at FROM imports ORDER BY id").all(), null, 2));
      db.close();
      return;
    }
    case "records": {
      const db = openDb();
      const id = parseNumArg(args[0], "导入ID");
      getImportOrThrow(db, id);
      console.log(JSON.stringify(db.prepare("SELECT line_no, raw, byte_count, offset, type, base, abs_start FROM records WHERE import_id = ? ORDER BY line_no").all(id), null, 2));
      db.close();
      return;
    }
    case "segments": {
      const db = openDb();
      const id = parseNumArg(args[0], "导入ID");
      for (const s of listSegments(db, id)) {
        console.log(`${hex8(s.start)}..${hex8(s.end - 1)}  (${s.end - s.start} 字节)  ${s.data.toString("hex").toUpperCase()}`);
      }
      db.close();
      return;
    }
    case "lookup": {
      const db = openDb();
      const id = parseNumArg(args[0], "导入ID");
      const addr = parseNumArg(args[1], "地址");
      console.log(JSON.stringify(lookupAddress(db, id, addr), null, 2));
      db.close();
      return;
    }
    case "export": {
      const [idS, startS, endS, outFile, ...rest] = args;
      if (!outFile) throw new HexError("E_VALIDATION", "用法：export <导入ID> <起始> <结束> <输出文件> [--fill 0xNN | --reject]");
      const db = openDb();
      const id = parseNumArg(idS, "导入ID");
      const start = parseNumArg(startS, "起始");
      const end = parseNumArg(endS, "结束");
      let fill: number | undefined;
      const fi = rest.indexOf("--fill");
      if (fi >= 0) fill = parseNumArg(rest[fi + 1], "fill");
      const result = exportRange(listSegments(db, id), start, end, { fill });
      const outPath = path.resolve("data", path.basename(outFile));
      fs.mkdirSync("data", { recursive: true });
      fs.writeFileSync(outPath, result.data);
      console.log(`已导出 ${result.data.length} 字节到 ${outPath}`);
      if (result.filledHoles.length) {
        console.log(`填充空洞：${result.filledHoles.map((h) => `${hex8(h.start)}..${hex8(h.end - 1)}`).join(", ")}`);
      }
      db.close();
      return;
    }
    case "demo": {
      const { runDemo } = await import("./demo.js");
      await runDemo();
      return;
    }
    default:
      usage();
      if (cmd) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("cli.js");
if (isMain) {
  runCli(process.argv.slice(2)).catch((err) => {
    if (err instanceof HexError) {
      console.error(`[${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
