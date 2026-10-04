import { loadConfig } from '../config';
import { HexStore } from '../db/database';
import { boundPort, startServer } from './api';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new HexStore(config.dataDir);
  const server = await startServer(config, store);
  const port = boundPort(server);
  console.log(`Intel HEX 后端已启动: http://${config.host}:${port}`);
  console.log(`数据目录: ${config.dataDir}`);
  console.log(`导出上限: ${config.maxExportBytes} 字节`);

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
