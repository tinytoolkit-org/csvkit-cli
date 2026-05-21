/** Type inference helpers used by stats / sort / filter. */

/** Detect the most-specific type for a string cell. */
export function inferType(s) {
  if (s === "" || s === null || s === undefined) return "null";
  if (s === "true" || s === "false" || s === "TRUE" || s === "FALSE") return "boolean";
  if (/^-?(0|[1-9]\d*)$/.test(s)) return "integer";
  if (/^-?(0|[1-9]\d*)?\.\d+$|^-?\d+\.\d+([eE][+-]?\d+)?$|^-?\d+([eE][+-]?\d+)$/.test(s)) return "number";
  if (/^\d{4}-\d{2}-\d{2}(T| )\d{2}:\d{2}/.test(s)) return "datetime";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  return "string";
}

/** Best-effort numeric parse for sort/filter. NaN if not numeric. */
export function asNumber(s) {
  if (s === "" || s == null) return NaN;
  if (typeof s === "number") return s;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return NaN;
}

/** Natural-sort key: split into runs of digits and non-digits. */
export function naturalKey(s) {
  const parts = [];
  const re = /(\d+)|(\D+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) parts.push({ n: Number(m[1]), s: m[1] });
    else parts.push({ s: m[2].toLowerCase() });
  }
  return parts;
}

export function compareNatural(a, b) {
  const ka = naturalKey(a == null ? "" : String(a));
  const kb = naturalKey(b == null ? "" : String(b));
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i], y = kb[i];
    if (x.n !== undefined && y.n !== undefined) {
      if (x.n !== y.n) return x.n - y.n;
    } else if (x.s !== y.s) {
      return x.s < y.s ? -1 : 1;
    }
  }
  return ka.length - kb.length;
}
