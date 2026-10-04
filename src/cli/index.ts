#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hex8, loadConfig, parseUint32 } from '../config';
import { HexStore } from '../db/database';
import { exportRange } from '../core/mapping';
import { HexError } from '../core/errors';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags };
}

const HELP = `Intel HEX 稀疏地址映射核验 CLI

用法: ihex <命令> [参数]

命令:
  import <file.hex> [--name 别名]
      导入 HEX 文件；相同文件重复导入返回既有映射（幂等）。
  list
      列出全部导入。
  records <importId>
      查询某次导入的原始记录（行号/类型/偏移/数据）。
  segments <importId>
      查看稀疏地址段与启动地址元数据。
  source <importId> --address <hex|dec>
      定位某绝对地址的字节值与来源记录行号。
  bytes <importId> [--start <a>] [--end <b>]
      列出映射字节（含每个地址的来源行号）。
  export <importId> --start <a> --end <b> [--gap reject|fill] [--fill <0..255>] [--out file.bin]
      导出区间二进制（半开写法：含 start 与 end）；默认拒绝空洞。
  help
      显示本帮助。

地址均为无符号 32 位，十六进制可带 0x 前缀。
`;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new HexStore(config.dataDir);
  const args = parseArgs(process.argv.slice(2));

  try {
    switch (args.command) {
      case 'import': {
        const file = args.positional[0];
        if (!file) throw new HexError('BAD_REQUEST', '缺少 HEX 文件路径');
        const text = fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, '');
        const summary = store.importHex(text, args.flags.name ?? path.basename(file));
        console.log(JSON.stringify(summary, null, 2));
        break;
      }
      case 'list': {
        console.log(JSON.stringify({ imports: store.listImports() }, null, 2));
        break;
      }
      case 'records': {
        const id = requireId(args);
        console.log(JSON.stringify({ importId: id, records: store.getRecords(id) }, null, 2));
        break;
      }
      case 'segments': {
        const id = requireId(args);
        const info = store.getImport(id);
        console.log(
          JSON.stringify(
            {
              importId: id,
              startAddresses: info.startAddresses.map((s) => ({
                kind: `0${s.kind.toString(16)}`,
                address: s.address,
                addressHex: hex8(s.address),
                line: s.line,
              })),
              segments: info.segments.map((s) => ({
                start: s.start,
                startHex: hex8(s.start),
                end: s.end,
                endHex: hex8(s.end),
                length: s.length,
              })),
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'source': {
        const id = requireId(args);
        if (args.flags.address === undefined) throw new HexError('BAD_REQUEST', '缺少 --address');
        const address = parseUint32(args.flags.address, 'address');
        const hit = store.findSource(id, address);
        console.log(
          JSON.stringify(
            {
              importId: id,
              address: hit.address,
              addressHex: hex8(hit.address),
              value: hit.value,
              valueHex: hit.value.toString(16).padStart(2, '0').toUpperCase(),
              sourceLines: hit.lines,
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'bytes': {
        const id = requireId(args);
        const start = args.flags.start !== undefined ? parseUint32(args.flags.start, 'start') : undefined;
        const end = args.flags.end !== undefined ? parseUint32(args.flags.end, 'end') : undefined;
        const mapped = store.getBytes(id, start, end);
        console.log(
          JSON.stringify(
            mapped.map((b) => ({
              addressHex: hex8(b.address),
              valueHex: b.value.toString(16).padStart(2, '0').toUpperCase(),
              sourceLines: b.sources,
            })),
            null,
            2,
          ),
        );
        break;
      }
      case 'export': {
        const id = requireId(args);
        if (args.flags.start === undefined || args.flags.end === undefined) {
          throw new HexError('BAD_REQUEST', 'export 需要 --start 与 --end');
        }
        const start = parseUint32(args.flags.start, 'start');
        const end = parseUint32(args.flags.end, 'end');
        const gapPolicy = args.flags.gap === 'fill' ? 'fill' : 'reject';
        let fillByte: number | undefined;
        if (gapPolicy === 'fill') {
          if (args.flags.fill === undefined) throw new HexError('BAD_REQUEST', '--gap fill 需要 --fill <0..255>');
          fillByte = parseUint32(args.flags.fill, 'fill');
          if (fillByte > 0xff) throw new HexError('BAD_REQUEST', '--fill 必须在 0..255 范围内');
        }
        const result = exportRange(store.getBytes(id), { start, end, maxBytes: config.maxExportBytes, gapPolicy, fillByte });
        const outArg = args.flags.out
          ? path.resolve(args.flags.out)
          : path.join(config.dataDir, 'exports', `import_${id}_${start.toString(16)}_${end.toString(16)}.bin`);
        fs.mkdirSync(path.dirname(outArg), { recursive: true });
        fs.writeFileSync(outArg, result.data);
        console.log(
          JSON.stringify(
            {
              out: outArg,
              length: result.length,
              filledBytes: result.filledBytes,
              filledGaps: result.filledGaps.map((g) => ({ startHex: hex8(g.start), endHex: hex8(g.end), length: g.length })),
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      case '': {
        process.stdout.write(HELP);
        break;
      }
      default:
        throw new HexError('BAD_REQUEST', `未知命令: ${args.command}`);
    }
  } finally {
    store.close();
  }
}

function requireId(args: Args): number {
  const raw = args.positional[0];
  if (raw === undefined || !/^\d+$/.test(raw)) throw new HexError('BAD_REQUEST', '需要数字 importId');
  return Number(raw);
}

main().catch((err: unknown) => {
  if (err instanceof HexError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else if (err instanceof RangeError) {
    console.error(`错误 [BAD_REQUEST]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
