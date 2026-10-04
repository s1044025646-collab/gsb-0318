// 独立计算校验和生成夹具：checksum = (-(count+addrHi+addrLo+type+data...)) & 0xFF
import fs from "node:fs";

function rec(offset: number, type: number, data: number[]): string {
  const bytes = [data.length, (offset >> 8) & 0xff, offset & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0);
  const chk = (-sum) & 0xff;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return ":" + hex(bytes[0]) + hex(bytes[1]) + hex(bytes[2]) + hex(bytes[3]) + data.map(hex).join("") + hex(chk);
}

const EOF = rec(0, 1, []);
const w = (name: string, lines: string[]) =>
  fs.writeFileSync(`fixtures/${name}`, lines.join("\r\n") + "\r\n");

// 空数据 + 结束
w("empty.hex", [EOF]);

// 演示：04 -> 两段不相邻数据 -> 02 -> 相同低位偏移的数据
w("demo.hex", [
  rec(0, 4, [0x00, 0x01]),                 // 基址 0x00010000
  rec(0x0000, 0, [0x11, 0x22, 0x33, 0x44]), // -> 0x10000
  rec(0x0010, 0, [0x55, 0x66, 0x77, 0x88]), // -> 0x10010（与上段不相邻）
  rec(0, 2, [0x00, 0x10]),                 // 基址 0x00000100
  rec(0x0000, 0, [0xaa, 0xbb, 0xcc, 0xdd]), // -> 0x00100（相同低位偏移，不同绝对地址）
  EOF,
]);

// 校验损坏（最后一个字节翻转）
const good = rec(0, 0, [0x01, 0x02, 0x03]);
w("bad_checksum.hex", [good.slice(0, -2) + "00", EOF]);

// 截断（半行）
w("truncated.hex", [rec(0, 0, [0x01]).slice(0, 6)]);

// 类型长度错：04 必须 2 字节，给 3 字节
w("bad_type_length.hex", [rec(0, 4, [0x00, 0x01, 0x02]), EOF]);

// 单条数据跨越 16 位偏移边界
w("offset_overflow.hex", [rec(0xfff0, 0, new Array(0x20).fill(0x5a)), EOF]);

// 相同重叠：同一地址写相同字节
w("overlap_same.hex", [
  rec(0x0100, 0, [0x01, 0x02, 0x03, 0x04]),
  rec(0x0102, 0, [0x03, 0x04, 0x05]),
  EOF,
]);

// 冲突重叠：同一地址写不同字节
w("overlap_conflict.hex", [
  rec(0x0100, 0, [0x01, 0x02, 0x03, 0x04]),
  rec(0x0102, 0, [0x03, 0x99, 0x05]),
  EOF,
]);

// 缺少结束记录
w("missing_eof.hex", [rec(0, 0, [0x01])]);

// 结束记录后仍有内容
w("after_eof.hex", [EOF, rec(0, 0, [0x01])]);

// 未知类型 06
w("unknown_type.hex", [rec(0, 6, [0x00]), EOF]);

// 无扩展状态、乱序数据（用于重排不变性测试）
w("reorderable.hex", [
  rec(0x0020, 0, [0x21, 0x22]),
  rec(0x0000, 0, [0x01, 0x02]),
  rec(0x0010, 0, [0x10, 0x11]),
  EOF,
]);

// 启动元数据 03 + 05
w("metadata.hex", [
  rec(0, 5, [0x00, 0x01, 0x00, 0x00]),
  rec(0, 3, [0x12, 0x34, 0xab, 0xcd]),
  rec(0, 0, [0xde, 0xad]),
  EOF,
]);

console.log("fixtures written");
