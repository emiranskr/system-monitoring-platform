import { badRequest } from "./errors.js";

/** Ham tampon govdeyi (app.ts'teki application/json ayristirici) JSON'a cevirir; bozuksa 400. */
export function jsonBody(req: { body: unknown }): unknown {
  if (!Buffer.isBuffer(req.body)) throw badRequest();
  try { return JSON.parse(req.body.toString("utf8")); } catch { throw badRequest(); }
}
