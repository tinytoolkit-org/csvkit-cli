import { createHash } from "node:crypto";

/** SHA1 hex of an array of string fields, joined with a non-collidable separator. */
export function sha1OfRow(row) {
  const h = createHash("sha1");
  for (let i = 0; i < row.length; i++) {
    const f = row[i] == null ? "" : String(row[i]);
    h.update(f.length.toString());
    h.update(":");
    h.update(f);
    h.update("\x01");
  }
  return h.digest("hex");
}

/** SHA1 hex of a single string value. */
export function sha1Of(s) {
  return createHash("sha1").update(String(s == null ? "" : s)).digest("hex");
}
