/**
 * RFC 4180 CSV parser + emitter. Streaming-first.
 *
 *   for await (const row of parseCsvStream("data.csv", { delim: "," })) { ... }
 *
 * Memory is bounded by the size of one row + the largest single quoted field —
 * NOT by the file size. State survives across chunk boundaries, including the
 * tricky case where a "" escape straddles a chunk break.
 */

import { createReadStream } from "node:fs";

/** Default chunk size for the stream reader. */
const CHUNK = 64 * 1024;

/** In-memory parse. Use parseCsvStream for files > a few MB. */
export function parseCsv(text, opts) {
  const delim = (opts && opts.delim) || ",";
  const quote = (opts && opts.quote) || '"';
  const rows = [];
  const state = newParserState();
  feed(state, text, delim, quote, (row) => rows.push(row));
  flush(state, (row) => rows.push(row));
  return rows;
}

/**
 * Async iterable over CSV rows, parsed RFC-4180.
 * Yields each row as an array of string fields.
 * Strips a UTF-8 BOM if present on the first byte.
 */
export async function* parseCsvStream(input, opts) {
  const delim = (opts && opts.delim) || ",";
  const quote = (opts && opts.quote) || '"';

  let source;
  if (input === "-" || input === undefined || input === null) source = process.stdin;
  else if (typeof input === "string") source = createReadStream(input, { encoding: "utf8", highWaterMark: CHUNK });
  else source = input;
  if (source.readableEncoding == null && typeof source.setEncoding === "function") {
    source.setEncoding("utf8");
  }

  const queue = [];
  const push = (row) => queue.push(row);
  const state = newParserState();
  let firstChunk = true;

  for await (const chunkRaw of source) {
    let chunk = String(chunkRaw);
    if (firstChunk) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      firstChunk = false;
    }
    feed(state, chunk, delim, quote, push);
    while (queue.length > 0) yield queue.shift();
  }
  flush(state, push);
  while (queue.length > 0) yield queue.shift();
}

/* ---------- parser internals ---------- */

function newParserState() {
  return {
    cur: [],
    field: "",
    inQuotes: false,
    /* true when the previous char was a closing quote and we're waiting to see
       whether the next char is another quote (escape) or a delimiter/newline. */
    pendingQuote: false,
  };
}

function feed(s, chunk, delim, quote, onRow) {
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];

    if (s.pendingQuote) {
      s.pendingQuote = false;
      if (ch === quote) {
        /* escaped quote inside the same quoted field */
        s.field += quote;
        s.inQuotes = true;
        continue;
      }
      /* fall through — the previous quote really did close the field */
      s.inQuotes = false;
    }

    if (s.inQuotes) {
      if (ch === quote) {
        /* might be a closing quote OR an escape — peek next char */
        if (i + 1 < chunk.length) {
          if (chunk[i + 1] === quote) {
            s.field += quote;
            i++;
            continue;
          }
          s.inQuotes = false;
          continue;
        }
        /* chunk boundary: defer the decision to the next chunk */
        s.pendingQuote = true;
        continue;
      }
      s.field += ch;
      continue;
    }

    if (ch === quote) {
      /* opening quote — only valid at the start of a field; if we're mid-field
         (mixed quoting), keep it as a literal char to be tolerant. */
      if (s.field === "") { s.inQuotes = true; continue; }
      s.field += ch;
      continue;
    }
    if (ch === delim) { s.cur.push(s.field); s.field = ""; continue; }
    if (ch === "\n") {
      s.cur.push(s.field);
      if (!(s.cur.length === 1 && s.cur[0] === "")) onRow(s.cur);
      s.cur = [];
      s.field = "";
      continue;
    }
    if (ch === "\r") continue;
    s.field += ch;
  }
}

function flush(s, onRow) {
  /* a deferred pending quote at EOF really did close the field */
  if (s.pendingQuote) { s.pendingQuote = false; s.inQuotes = false; }
  if (s.field.length > 0 || s.cur.length > 0) {
    s.cur.push(s.field);
    if (!(s.cur.length === 1 && s.cur[0] === "")) onRow(s.cur);
  }
}

/* ---------- emit ---------- */

/** RFC 4180 cell emit. Always uses CRLF-safe quoting when needed. */
export function emitCell(v, delim, quote) {
  const q = quote || '"';
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.indexOf(q) !== -1 || s.indexOf(delim) !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
    return q + s.split(q).join(q + q) + q;
  }
  return s;
}

/** Emit a row as a CSV line (no trailing newline). */
export function emitRow(row, delim, quote) {
  const q = quote || '"';
  const d = delim || ",";
  const parts = new Array(row.length);
  for (let i = 0; i < row.length; i++) parts[i] = emitCell(row[i], d, q);
  return parts.join(d);
}

/** Convert a row + header to an object, with optional dot-nesting. */
export function rowToObject(header, row, opts) {
  const types = opts && opts.types ? opts.types : "auto";
  const nest = opts && opts.nest ? opts.nest : "flat";
  const obj = {};
  const n = Math.max(header.length, row.length);
  for (let i = 0; i < n; i++) {
    const key = header[i];
    if (!key) continue;
    const raw = row[i];
    if (raw === undefined) continue;
    const val = coerce(raw, types);
    if (nest === "dot" && key.indexOf(".") !== -1) setDot(obj, key, val);
    else obj[key] = val;
  }
  return obj;
}

/** Strict typed coerce — only converts unambiguous patterns. */
export function coerce(s, mode) {
  if (mode === "string") return s;
  if (s === "") return mode === "blank-null" ? null : "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function setDot(obj, dotKey, val) {
  const parts = dotKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/** Flatten a nested object to dotted keys for CSV emission. */
export function flatten(obj, prefix) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const key = prefix ? prefix + "." + k : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") Object.assign(out, flatten(item, key + "." + i));
        else out[key + "." + i] = item;
      });
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Map a column spec ("name" or "1-indexed number") to a header index. */
export function resolveColumn(header, spec) {
  if (!header) return -1;
  const i = header.indexOf(spec);
  if (i !== -1) return i;
  const n = Number(spec);
  if (Number.isInteger(n) && n >= 1 && n <= header.length) return n - 1;
  return -1;
}

/** Split a comma-separated list, respecting backslash-escaped commas. */
export function splitList(s) {
  if (!s) return [];
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === ",") { cur += ","; i++; continue; }
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}
