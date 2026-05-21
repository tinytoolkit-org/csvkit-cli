/**
 * Backpressure-aware writable wrapper + EPIPE handler.
 *
 *   const out = makeWriter(process.stdout);
 *   await out.write("line\n");
 */

import { once } from "node:events";

export function makeWriter(stream) {
  const s = stream || process.stdout;
  return {
    async write(chunk) {
      if (!s.write(chunk)) {
        try { await once(s, "drain"); }
        catch (e) { if (e && e.code !== "EPIPE") throw e; }
      }
    },
    async drain() {
      if (s.writableNeedDrain) {
        try { await once(s, "drain"); }
        catch (e) { if (e && e.code !== "EPIPE") throw e; }
      }
    },
    raw: s,
  };
}

/** Install a top-level EPIPE handler so `csvkit X | head` exits cleanly. */
export function installBrokenPipeHandler() {
  process.stdout.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(0);
  });
  process.stderr.on("error", () => { /* swallow */ });
}
