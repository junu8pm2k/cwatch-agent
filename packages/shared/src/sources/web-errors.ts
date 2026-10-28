export class WebFailure extends Error {
  constructor(readonly code: 'unsupported' | 'unavailable' | 'auth_failed' | 'rate_limited' | 'parse_failed' | 'unknown', message: string) { super(message); }
}
