/** Per-column statistics accumulator. */

import { inferType, asNumber } from "./coerce.js";

export function createColumnAccumulator() {
  return {
    count: 0,
    nulls: 0,
    types: new Map(), // type -> count
    unique: new Set(),
    uniqueDropped: false, // set true once we stop tracking (cardinality cap)
    min: null,
    max: null,
    sum: 0,
    nNumeric: 0,
    minLen: Infinity,
    maxLen: 0,
  };
}

const UNIQUE_CAP = 50000;

export function addCell(acc, cell) {
  acc.count++;
  if (cell === "" || cell == null) {
    acc.nulls++;
    addType(acc, "null");
    return;
  }
  const t = inferType(cell);
  addType(acc, t);
  const len = cell.length;
  if (len < acc.minLen) acc.minLen = len;
  if (len > acc.maxLen) acc.maxLen = len;
  if (!acc.uniqueDropped) {
    acc.unique.add(cell);
    if (acc.unique.size > UNIQUE_CAP) { acc.uniqueDropped = true; acc.unique = null; }
  }
  if (t === "number" || t === "integer") {
    const n = asNumber(cell);
    acc.sum += n;
    acc.nNumeric++;
    if (acc.min === null || n < acc.min) acc.min = n;
    if (acc.max === null || n > acc.max) acc.max = n;
  }
}

function addType(acc, t) {
  acc.types.set(t, (acc.types.get(t) || 0) + 1);
}

export function summarize(acc) {
  const types = {};
  for (const [k, v] of acc.types) types[k] = v;
  return {
    count: acc.count,
    nulls: acc.nulls,
    types,
    unique: acc.uniqueDropped ? null : acc.unique.size,
    uniqueCapped: acc.uniqueDropped,
    numeric: acc.nNumeric === acc.count - acc.nulls && acc.nNumeric > 0,
    min: acc.nNumeric > 0 ? acc.min : null,
    max: acc.nNumeric > 0 ? acc.max : null,
    avg: acc.nNumeric > 0 ? acc.sum / acc.nNumeric : null,
    minLen: acc.minLen === Infinity ? 0 : acc.minLen,
    maxLen: acc.maxLen,
  };
}

export function humanBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
