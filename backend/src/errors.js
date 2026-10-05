import { ZodError } from 'zod';

/**
 * An error meant for the client. Its message is shown to the user by the
 * app (see the upload contract), so keep it plain.
 */
export class HttpError extends Error {
  /** `extra` adds fields to the response body, e.g. why approval is blocked. */
  constructor(status, message, { code, extra } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new HttpError(400, msg, { code: 'bad_request' });
export const unauthorised = (msg = 'Sign in again.') =>
  new HttpError(401, msg, { code: 'unauthorised' });
export const forbidden = (msg = 'You do not have access to this.') =>
  new HttpError(403, msg, { code: 'forbidden' });
// Also used for other tenants' data: never confirm it exists.
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, { code: 'not_found' });
export const conflict = (msg, extra) => new HttpError(409, msg, { code: 'conflict', extra });

/** Express error handler: `{ message, code }` bodies, no stack traces out. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return res
      .status(400)
      .json({ message: `${where}${first?.message ?? 'Invalid request.'}`, code: 'invalid' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ ...err.extra, message: err.message, code: err.code });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'The request body is not valid JSON.', code: 'invalid' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'The request is too large.', code: 'too_large' });
  }
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on our side.', code: 'internal' });
}
