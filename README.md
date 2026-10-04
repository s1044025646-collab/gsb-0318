# Intel HEX 固件记录与稀疏地址映射核验后端

纯本地、离线的 Intel HEX (`.hex`) 检查后端：把记录还原为**稀疏字节地址映射**，说明每个字节来自哪条记录，并可导出指定地址区间的二进制。只处理项目内的**合成固件文本夹具**——不连接设备、不烧写硬件、不执行任何文件内容、不扫描用户系统文件。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`，无原生编译依赖）
- 形态：仅 HTTP API + CLI（无前端）
- 平台：Windows 本地直接运行，无需 Docker、WSL、付费服务或在线 API
- 要求：Node.js >= 22.5（开发与验证使用 Node v25）

## 支持的记录子集

| 类型 | 名称 | 行为 |
| --- | --- | --- |
| `00` | 数据 | 数据字段长度任意；按“当前基址 + 记录 16 位偏移”放置到绝对地址 |
| `01` | 文件结束 EOF | 必须合法且恰好出现一次；其后不得再有非空记录 |
| `02` | 扩展段地址 | 基址 = 字段值 **× 16** |
| `04` | 扩展线性地址 | 基址 = 字段值 **× 65536 (0x10000)** |
| `03` | 启动段地址 (CS:IP) | **仅作元数据**保留，地址 = CS×16 + IP；不改变数据基址、不产生数据字节 |
| `05` | 扩展线性启动地址 | **仅作元数据**保留；不改变数据基址、不产生数据字节 |
| 其他 | — | 明确报 `UNSUPPORTED_RECORD_TYPE` |

地址规则与校验：

- 地址统一为**无符号 32 位**整数（范围 `0..0xFFFFFFFF`）。数据库与 API 字段均为无符号数值；`*Hex` 字段仅用于显示。
- “最近一次” `02`/`04` 扩展记录决定后续数据基址；`03`/`05` 不影响基址。
- 记录偏移是记录内 16 位字段，**不是文件行号/字节位置**；不会沿用最早的扩展记录。
- 自行解析冒号、字节计数、地址、类型、数据与校验字节；全部字节之和模 256 必须为 0。
- 接受大小写十六进制与 CRLF/CR/LF 换行和空行、UTF-8 BOM；**拒绝**行内空白与多余字符。
- 校验声明长度与类型专属长度（01=0、02/04=2、03/05=4 字节）。
- 拒绝单条数据跨越 16 位偏移边界（`0xFFFF -> 0x0000` 回绕）。
- 拒绝绝对地址溢出 32 位（落在 `0xFFFFFFFF` 本身是合法的）。
- 缺少 EOF 或 EOF 后出现记录都报错。

## 稀疏映射语义

- 数据记录可乱序、相邻或重叠。
- **相同地址写相同字节**：合并为一个映射字节，但**保留全部来源行号**。
- **相同地址写不同字节**：整次导入失败（`CONFLICTING_DATA`，409），报告绝对地址、双方行号与冲突值；**绝不最后写入覆盖**。
- 相邻已定义字节合成区间；**空洞保持空洞**，映射阶段不自动补零。
- 同类启动元数据重复出现时必须一致，否则 `CONFLICTING_START_ADDRESS`；03 与 05 分别保存。
- 失败的导入在一个事务内回滚，**不会发布部分映射**；导入失败后旧映射仍可读。
- 以原文 SHA-256 去重：相同文件重复导入固定返回既有映射（幂等），旧映射不随后续文件变化。

## 快速开始

```powershell
npm install
npm run build
npm test
npm start
```

`npm start` 默认把端口设为 `0`（由系统选择空闲端口），启动后会打印实际地址。配置可用环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `IHEX_PORT` | `0` | 监听端口，`0` = 空闲端口 |
| `IHEX_HOST` | `127.0.0.1` | 监听地址（仅本机） |
| `IHEX_DATA_DIR` | `./data` | SQLite 与导出文件目录（项目内） |
| `IHEX_MAX_EXPORT_BYTES` | `1048576` | 单次导出区间字节数上限 |

## CLI

编译后使用 `node dist/cli/index.js <命令>`（地址接受十六进制，可带 `0x`）：

```powershell
node dist/cli/index.js import fixtures/demo.hex
node dist/cli/index.js list
node dist/cli/index.js records 1
node dist/cli/index.js segments 1
node dist/cli/index.js source 1 --address 0x00010000
node dist/cli/index.js bytes 1 --start 0x10000 --end 0x10101
# 导出含空洞区间：默认 reject；fill 必须显式给填充字节，并报告实际填充位置
node dist/cli/index.js export 1 --start 0x10000 --end 0x10101 --gap fill --fill 0xFF
```

导出规则：区间为闭区间（含 `start` 与 `end`）；超过 `IHEX_MAX_EXPORT_BYTES` 返回 `EXPORT_TOO_LARGE` (413)；区间含空洞时 `reject` 返回 `EXPORT_HAS_GAPS` (422)，`fill` 用 `fillByte`（0..255）填充并在 `filledGaps`/`filledBytes` 中报告每个被填充的位置与数量。导出文件写入 `data/exports/`。

## HTTP API

所有请求/响应均为 JSON。错误体形如 `{ "error": { "code", "message", "details?" } }`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /imports` | body `{ "hexText": "...", "fileName"?: "..." }`；成功 201，重复文件 200 且 `reused:true` |
| `GET /imports` | 列出全部导入（含 sha256、格式版本、记录/字节/区间数） |
| `GET /imports/{id}/records` | 原始记录：行号、类型、16 位偏移、数据、原文 |
| `GET /imports/{id}/segments` | 稀疏区间与 03/05 启动元数据 |
| `GET /imports/{id}/bytes?start=&end=` | 映射字节（含每个地址的 `sourceLines`）；范围可选 |
| `GET /imports/{id}/source?address=` | 定位单个绝对地址的值与来源记录行号 |
| `POST /imports/{id}/export` | `{ start, end, gapPolicy: "reject"|"fill", fillByte? }`，写文件到 `data/exports/` |

PowerShell 调用示例：

```powershell
$hex = Get-Content -Raw fixtures/demo.hex
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/imports -ContentType 'application/json' `
  -Body (@{ hexText = $hex; fileName = 'demo.hex' } | ConvertTo-Json)
Invoke-RestMethod "http://127.0.0.1:<port>/imports/1/source?address=0x000F0000"
```

错误码：`BAD_LINE_FORMAT`、`ODD_HEX_LENGTH`、`INVALID_HEX_CHAR`、`LINE_INLINE_WHITESPACE`、`LINE_TOO_SHORT`、`COUNT_MISMATCH`、`CHECKSUM_FAILED`、`UNSUPPORTED_RECORD_TYPE`、`TYPE_LENGTH_MISMATCH`、`CROSSES_64K_BOUNDARY`、`ADDRESS_OVERFLOW`、`MISSING_EOF`、`RECORD_AFTER_EOF`、`CONFLICTING_DATA`、`CONFLICTING_START_ADDRESS`、`EXPORT_TOO_LARGE`、`EXPORT_HAS_GAPS`、`INVALID_RANGE`、`NOT_FOUND`、`BAD_REQUEST`。

## 数据存储

SQLite 文件 `data/ihex.sqlite`，表：`imports`（原文、SHA-256、解析格式版本 `parser_format_version=1`、计数）、`records`、`start_addresses`、`bytes_map`、`byte_sources`（地址→来源行号）、`segments`。导入在单个事务内提交，失败回滚。

## 演示夹具与测试

夹具全部为**手写校验和**的合成数据，位于 `fixtures/`：

- `demo.hex`：`04=0x0001` 后放两段不相邻数据（`0x10000`、`0x10100`），再切到 `02=0xF000`，用同样低偏移 `0x0000` 写数据到 `0xF0000`，并含 03/05 元数据。
- `empty_data.hex`（空数据+EOF）、`bad_checksum.hex`、`truncated.hex`、`bad_type_length.hex`、`overflow.hex`、`cross_64k.hex`、`overlap_same.hex`、`overlap_conflict.hex`、`missing_eof.hex`、`after_eof.hex`、`unknown_type.hex`、`reorder.hex`。

测试（`npm test`，node:test）逐字节核对地址映射与来源行号，验证记录重排不改变结果、空洞填充位置与导出长度、冲突报错字段、失败导入不留数据，以及**重新打开数据库（模拟服务重启）后原映射仍可查询**。

一键演示（构建、CLI 全流程、坏文件拒绝、启动 HTTP 服务查询、停止）：

```powershell
npm run demo
```

## 明确限制

- 仅支持上述 6 种记录类型；`06` 及以上未知类型直接拒绝。
- 单条数据记录不得跨越 64K 偏移边界（标准实践之外的宽松情形不在本子集内）。
- 不做任何硬件交互、固件执行或设备烧写；仅解析与核验文本。
- 服务默认只监听 `127.0.0.1`。
