/**
 * Heuristic delimiter / quote / header detection.
 * Reads a sample (first ~64 KB) and picks the delimiter whose per-row field
 * count is most consistent across rows.
 */

import { open } from "node:fs/promises";

const CANDIDATES = [",", ";", "\t", "|"];

/** Sniff a file. Returns { delim, quote, hasHeader, sample }. */
export async function sniffFile(path, sampleBytes) {
  const handle = await open(path, "r");
  try {
    const bytes = sampleBytes || 65536;
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    return sniffText(text);
  } finally {
    await handle.close();
  }
}

/** Sniff a text sample. */
export function sniffText(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = splitNonquotedLines(text).slice(0, 50);
  if (lines.length === 0) return { delim: ",", quote: '"', hasHeader: true, sample: [] };

  let best = { delim: ",", score: -Infinity, counts: [] };
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countDelim(l, d));
    /* score: prefer >0 fields per line + low variance + many fields */
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
    const variance = nonZero.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nonZero.length;
    const consistency = 1 / (1 + variance);
    const score = mean * consistency * (nonZero.length / lines.length);
    if (score > best.score) best = { delim: d, score, counts };
  }

  /* parse first ~10 rows to get a sample */
  const sample = [];
  const head = lines.slice(0, 10).join("\n");
  // Local quick parse using detected delim
  const rows = quickParse(head, best.delim);
  for (const r of rows) sample.push(r);

  /* header heuristic: first row has more non-numeric cells than typical */
  let hasHeader = false;
  if (sample.length >= 2) {
    const numericRatio = (row) => {
      const numeric = row.filter((c) => /^-?\d+(\.\d+)?$/.test(c)).length;
      return row.length === 0 ? 0 : numeric / row.length;
    };
    const headRatio = numericRatio(sample[0]);
    const restRatio = sample.slice(1).map(numericRatio);
    const restAvg = restRatio.reduce((a, b) => a + b, 0) / Math.max(1, restRatio.length);
    hasHeader = headRatio < 0.2 && restAvg >= 0.2;
    /* also flag header when all first-row cells look like identifiers */
    if (!hasHeader) {
      const ident = sample[0].filter((c) => /^[A-Za-z_][\w .-]*$/.test(c)).length;
      if (sample[0].length > 0 && ident / sample[0].length > 0.8 && restAvg > 0) hasHeader = true;
    }
  }

  return { delim: best.delim, quote: '"', hasHeader, sample };
}

/* Split a text into lines, ignoring newlines inside quoted fields. */
function splitNonquotedLines(text) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { inQ = !inQ; cur += c; continue; }
    if (c === "\n" && !inQ) { out.push(cur); cur = ""; continue; }
    if (c === "\r") continue;
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function countDelim(line, d) {
  let count = 0, inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === d && !inQ) count++;
  }
  return count + 1;
}

function quickParse(text, d) {
  const rows = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQ = false; continue; }
      field += c; continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === d) { cur.push(field); field = ""; continue; }
    if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field !== "" || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}
