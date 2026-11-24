export class WebFailure extends Error {
  readonly protocolMismatch?: boolean;
  constructor(
    readonly code: 'unsupported' | 'unavailable' | 'auth_failed' | 'rate_limited' | 'parse_failed' | 'unknown',
    message: string,
    options?: { protocolMismatch?: boolean },
  ) {
    super(message);
    if (options?.protocolMismatch) this.protocolMismatch = true;
  }
}
