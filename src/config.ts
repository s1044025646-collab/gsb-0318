import * as path from 'node:path';

export interface AppConfig {
  /** 数据目录（SQLite 与导出文件均留在此处）。 */
  dataDir: string;
  /** 0 表示启动时选择空闲端口。 */
  port: number;
  host: string;
  /** 导出区间字节数上限。 */
  maxExportBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AppConfig {
  const dataDir = path.resolve(cwd, env.IHEX_DATA_DIR ?? path.join('data'));
  const port = env.IHEX_PORT ? Number.parseInt(env.IHEX_PORT, 10) : 0;
  const maxExportBytes = env.IHEX_MAX_EXPORT_BYTES ? Number.parseInt(env.IHEX_MAX_EXPORT_BYTES, 10) : 1 << 20; // 1 MiB
  return {
    dataDir,
    port: Number.isInteger(port) && port >= 0 && port <= 0xffff ? port : 0,
    host: env.IHEX_HOST ?? '127.0.0.1',
    maxExportBytes: Number.isInteger(maxExportBytes) && maxExportBytes > 0 ? maxExportBytes : 1 << 20,
  };
}

/** 将十六进制（0x 前缀可选）或十进制字符串解析为无符号 32 位整数。 */
export function parseUint32(input: string, fieldName: string): number {
  const trimmed = input.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
    throw new RangeError(`${fieldName} 必须是十六进制（可带 0x）或十进制整数`);
  }
  const value = trimmed.toLowerCase().startsWith('0x')
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${fieldName} 超出无符号 32 位范围 (0..0xFFFFFFFF)`);
  }
  return value;
}

export function hex8(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(8, '0');
}
