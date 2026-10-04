import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntelHex } from "../src/parser.js";

test("32 位地址边界：0xFFFFFFFF 可表示，越界由解析器守护", () => {
  // 基址 0xFFFF0000 + 偏移 0xFFFF，单字节 -> 绝对地址 0xFFFFFFFF（合法）
  const r = parseIntelHex(":02000004FFFFFC\n:01FFFF000001\n:00000001FF\n");
  const d = r.records.find((x) => x.type === 0)!;
  assert.equal(d.absStart, 0xffffffff);
});
