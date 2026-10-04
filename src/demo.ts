import fs from "node:fs";
import path from "node:path";
import { openDb, importHex, listSegments, lookupAddress } from "./db.js";

const hex8 = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(8, "0");

// 演示：04 扩展线性地址后放入两段不相邻数据，再切换 02 扩展段地址。
// 相同低位偏移 0x0000 在两种基址下指向不同绝对地址。
export async function runDemo() {
  const content = fs.readFileSync(path.resolve("fixtures", "demo.hex"), "utf8");
  const db = openDb();
  const imp = importHex(db, "demo.hex", content);
  console.log(`导入 #${imp.id}（${imp.duplicate ? "已存在，复用" : "新建"}）\n`);

  console.log("记录与生效基址：");
  const rows = db.prepare("SELECT line_no, raw, type, base, abs_start FROM records WHERE import_id = ? ORDER BY line_no").all(imp.id) as
    { line_no: number; raw: string; type: number; base: number | null; abs_start: number | null }[];
  for (const r of rows) {
    const extra = r.type === 0 ? `  基址=${hex8(r.base!)} 绝对起始=${hex8(r.abs_start!)}` : "";
    console.log(`  第${r.line_no}行 ${r.raw}${extra}`);
  }

  console.log("\n稀疏地址段：");
  for (const s of listSegments(db, imp.id)) {
    console.log(`  ${hex8(s.start)}..${hex8(s.end - 1)}  ${s.data.toString("hex").toUpperCase()}`);
  }

  console.log("\n相同低位偏移 0x0000 的来源定位：");
  for (const addr of [0x10000, 0x00100]) {
    const r = lookupAddress(db, imp.id, addr);
    console.log(`  ${hex8(addr)} -> 值 0x${(r.value ?? 0).toString(16).padStart(2, "0").toUpperCase()}，来自第 ${r.sources.map((s) => s.lineNo).join("/")} 行`);
  }
  db.close();
}
