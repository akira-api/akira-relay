export type RelayErrorCode =
  | "VIDEO_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "TOKEN_EXPIRED"
  | "FORBIDDEN_TARGET"
  | "INVALID_TOKEN"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";

export interface RelayErrorPayload {
  error: {
    code: RelayErrorCode;
    message: string;
    upstreamStatus?: number;
  };
}

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly statusCode: number;
  readonly upstreamStatus?: number;

  constructor(
    code: RelayErrorCode,
    message: string,
    statusCode: number,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
  }

  toPayload(): RelayErrorPayload {
    const payload: RelayErrorPayload = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.upstreamStatus !== undefined) {
      payload.error.upstreamStatus = this.upstreamStatus;
    }
    return payload;
  }
}
