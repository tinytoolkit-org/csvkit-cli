/** Tiny stderr progress meter. Only ticks when stderr is a TTY. */

export function createProgress(label, opts) {
  const enabled = !!(opts && opts.enabled) && process.stderr.isTTY;
  const intervalMs = (opts && opts.intervalMs) || 500;
  const startedAt = Date.now();
  let lastTick = 0;
  let records = 0;
  let bytes = 0;

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function maybeTick(force) {
    if (!enabled) return;
    const now = Date.now();
    if (!force && now - lastTick < intervalMs) return;
    lastTick = now;
    const secs = Math.max(0.001, (now - startedAt) / 1000);
    const rate = Math.round(records / secs);
    const bytesPerSec = bytes / secs;
    process.stderr.write(
      "\r" + label + ": " + records + " rows · " + fmtBytes(bytes) +
      " · " + rate + "/s · " + fmtBytes(bytesPerSec) + "/s    "
    );
  }

  return {
    bumpRecord(byteCount) {
      records++;
      if (byteCount) bytes += byteCount;
      maybeTick(false);
    },
    finish() {
      if (!enabled) return;
      maybeTick(true);
      process.stderr.write("\n");
    },
    enabled,
  };
}
