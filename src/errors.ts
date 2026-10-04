export type ErrorCode =
  | "E_SYNTAX"          // 行格式非法（冒号/hex 字符/行内空白/多余内容）
  | "E_CHECKSUM"        // 校验和不为零
  | "E_LENGTH"          // 声明字节数与实际数据长度不符
  | "E_TYPE_LENGTH"     // 类型专属长度不符（01=0, 02=2, 03=4, 04=2, 05=4）
  | "E_UNSUPPORTED_TYPE"// 未知记录类型
  | "E_OFFSET_OVERFLOW" // 单条数据跨越 16 位偏移边界
  | "E_ADDR_OVERFLOW"   // 绝对地址超出 32 位无符号范围
  | "E_EOF_MISSING"     // 缺少结束记录
  | "E_AFTER_EOF"       // 结束记录后仍有非空记录
  | "E_META_CONFLICT"   // 同类启动元数据不一致
  | "E_CONFLICT"        // 重叠字节值冲突
  | "E_HOLE"            // 导出范围包含空洞且未指定填充
  | "E_RANGE"           // 导出范围非法或超过上限
  | "E_NOT_FOUND"       // 资源不存在
  | "E_VALIDATION";     // 参数校验失败

export class HexError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HexError";
  }
}
