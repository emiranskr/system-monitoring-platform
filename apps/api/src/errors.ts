/** Tek tip hata govdesi: ayrinti (neden reddedildigi) disariya sizdirilmaz. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized");
export const badRequest = () => new HttpError(400, "bad_request");
