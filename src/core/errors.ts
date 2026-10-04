/** 带稳定错误码的业务错误，API 与 CLI 共用。 */
export class HexError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HexError';
  }
}

export type ErrorCode =
  | 'EMPTY_FILE'
  | 'BAD_LINE_FORMAT'
  | 'ODD_HEX_LENGTH'
  | 'INVALID_HEX_CHAR'
  | 'LINE_INLINE_WHITESPACE'
  | 'LINE_TOO_SHORT'
  | 'COUNT_MISMATCH'
  | 'CHECKSUM_FAILED'
  | 'UNSUPPORTED_RECORD_TYPE'
  | 'TYPE_LENGTH_MISMATCH'
  | 'CROSSES_64K_BOUNDARY'
  | 'ADDRESS_OVERFLOW'
  | 'MISSING_EOF'
  | 'RECORD_AFTER_EOF'
  | 'EMPTY_EOF_WITH_DATA'
  | 'CONFLICTING_DATA'
  | 'CONFLICTING_START_ADDRESS'
  | 'EXPORT_TOO_LARGE'
  | 'EXPORT_HAS_GAPS'
  | 'INVALID_RANGE'
  | 'NOT_FOUND'
  | 'BAD_REQUEST';

export interface ErrorBody {
  error: {
    code: ErrorCode | 'INTERNAL';
    message: string;
    details?: Record<string, unknown>;
  };
}
