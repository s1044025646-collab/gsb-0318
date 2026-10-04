# Intel HEX 固件记录与稀疏地址映射核验后端

离线 Intel HEX 文件检查后端：接收项目内文本夹具，将记录还原为稀疏字节地址映射，解释每段字节来自哪条记录，并导出指定地址区间。**只处理合成固件数据**：不连接设备、不烧写硬件、不执行内容、不扫描用户系统文件。仅提供 API 与 CLI，无前端。

技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`）+ SQLite。Windows 本地运行，无 Docker / WSL / 在线服务依赖。

## 支持子集（明确范围）

- 记录类型：`00` 数据、`01` 文件结束、`02` 扩展段地址（基址 = 字段值 × 16）、`04` 扩展线性地址（基址 = 字段值 × 65536）。
- `03` / `05` 仅作为启动地址元数据保存，不改变数据基址，也不产生数据字节；同类重复出现必须一致。
- 最近一次扩展记录决定后续数据的基址；绝对地址 = 基址 + 记录内 16 位偏移。
- 地址统一为无符号 32 位整数（`0..0xFFFFFFFF`），展示时可带 `0x` 前缀，数据库与 API 中均为十进制数值语义。
- 自行解析冒号、字节计数、地址、类型、数据与校验字节；各字节和模 256 必须为 0。
- 允许大小写十六进制与 CRLF/LF 换行；不允许行内空白或多余内容。
- 明确拒绝：单条数据跨越 16 位偏移边界、绝对地址溢出、未知记录类型、结束后出现非空记录、缺少结束记录。
- 数据记录可乱序、相邻或重叠：相同地址写相同字节合并并保留全部来源行号；写不同字节则**整次导入失败**，报告绝对地址、双方行号与冲突值（不做最后写入覆盖）。
- 相邻已定义字节合成区间，空洞保持空洞，映射阶段不自动补零。

## 快速开始

```powershell
npm install        # 仅需 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口）
node dist/src/cli.js serve --port 8080   # 指定端口
npm run demo       # 扩展地址演示
```

数据目录为项目内 `data/`（SQLite 库 `data/hexmap.db` 与导出文件均在此），夹具在 `fixtures/`。

## CLI

```
node dist/src/cli.js import fixtures/demo.hex        # 导入
node dist/src/cli.js imports                         # 列出导入
node dist/src/cli.js records 1                       # 查询记录（含每条生效基址）
node dist/src/cli.js segments 1                      # 查看稀疏地址段
node dist/src/cli.js lookup 1 0x10000                # 定位某地址来源
node dist/src/cli.js export 1 0x10000 0x10014 out.bin --fill 0x00   # 导出（含空洞须 --fill 或 --reject）
node dist/src/cli.js demo                            # 演示
```

## HTTP API

默认绑定 `127.0.0.1`，未指定端口时自动选择空闲端口并打印。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/imports` | 导入。`{"filename":"demo.hex"}`（仅允许 fixtures 目录内文件）或 `{"filename":"x","content":"..."}` |
| GET | `/api/imports` | 列出导入（含 sha256、格式版本、启动元数据） |
| GET | `/api/imports/:id` | 导入详情 |
| GET | `/api/imports/:id/records` | 全部记录（含每条数据记录生效的基址与绝对起始） |
| GET | `/api/imports/:id/segments` | 稀疏地址段（十进制 + 十六进制展示） |
| GET | `/api/imports/:id/lookup?addr=0x10000` | 定位某地址的字节值与来源行号 |
| GET | `/api/imports/:id/export?start=0x10000&end=0x10014&fill=0x00` | 导出二进制；`fill` 省略或 `reject` 时遇空洞报错；填充位置经 `X-Filled-Holes` 响应头报告 |

导出范围上限默认 1 MiB（`createServer` 可配置），`end` 为开区间。

### 错误码

统一返回 `{"error":{"code","message","details"}}`：

`E_SYNTAX` 行格式非法 · `E_CHECKSUM` 校验和错误 · `E_LENGTH` 声明长度不符 · `E_TYPE_LENGTH` 类型专属长度错误 · `E_UNSUPPORTED_TYPE` 未知类型 · `E_OFFSET_OVERFLOW` 跨 16 位偏移边界 · `E_ADDR_OVERFLOW` 绝对地址溢出 · `E_EOF_MISSING` 缺少结束记录 · `E_AFTER_EOF` 结束后仍有内容 · `E_META_CONFLICT` 启动元数据不一致 · `E_CONFLICT` 重叠字节冲突 · `E_HOLE` 导出遇空洞未指定填充 · `E_RANGE` 范围非法/超限 · `E_NOT_FOUND` 资源不存在 · `E_VALIDATION` 参数校验失败

## 持久化与语义

- SQLite 保存：原文摘要（sha256）、解析格式版本（`ihex-subset-1`）、每条记录及其生效基址、稀疏段、逐字节来源、启动元数据。
- 导入在单事务内完成：解析或映射冲突失败时不发布任何部分映射，旧数据保持可读。
- 相同文件（sha256 相同）重复导入为固定幂等行为：返回已有导入 ID，不产生新映射。
- 每次导入独立建图，旧映射不随新文件变化；服务重启后可继续查询原映射。

## 演示说明

`fixtures/demo.hex`：先发 `04`（基址 `0x00010000`）放两段不相邻数据（偏移 `0x0000`、`0x0010`），再切换 `02`（基址 `0x00000100`）后在相同低位偏移 `0x0000` 写数据。相同低位偏移因此指向不同绝对地址 `0x00010000` 与 `0x00000100`，`npm run demo` 逐条展示生效基址、稀疏段与来源行号。

## 夹具与测试

`fixtures/` 由 `scripts/make-fixtures.ts` 独立计算校验和生成（`npm run fixtures` 可重建），覆盖：空数据+结束、校验损坏、截断、类型长度错、跨偏移边界、相同重叠、冲突重叠、缺少结束、结束后内容、未知类型、乱序数据、启动元数据。

测试（`npm test`，20 个用例）逐字节核对地址映射与来源行号，验证：无扩展状态依赖的数据记录重排结果不变、空洞填充与导出长度、导入失败后旧数据可读、重复导入幂等、关闭并重开数据库（模拟服务重启）后原映射可查。

## 已知限制

- 仅支持上述记录类型子集；类型 `03`/`05` 不校验其指向是否落在映射内。
- 单条数据记录不允许跨越 16 位偏移边界（子集约束，非完整 Intel HEX 行为）。
- 逐字节来源表适合中小规模固件；超大文件会显著增大数据库。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning），API 稳定前建议锁定 Node 版本。
