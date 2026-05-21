/**
 * Whole-input reader for non-streaming commands.
 * Strips a UTF-8 BOM if present.
 */
import { createReadStream } from "node:fs";

export async function readAll(input) {
  let source;
  if (input === "-" || input === undefined || input === null) source = process.stdin;
  else if (typeof input === "string") source = createReadStream(input, { encoding: "utf8" });
  else source = input;
  if (source.readableEncoding == null && typeof source.setEncoding === "function") {
    source.setEncoding("utf8");
  }
  let buf = "";
  for await (const chunk of source) buf += chunk;
  if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
  return buf;
}
