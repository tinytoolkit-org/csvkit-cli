import { emitRow, emitCell, flatten } from "../core/csv.js";
import { readAll } from "../core/stream.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit from — convert anything to CSV

USAGE
  csvkit from json [file]    parses a JSON array of objects (whole-file)
  csvkit from jsonl [file]   one JSON object per line — streams
  csvkit from tsv [file]     TSV -> CSV
  csvkit from md [file]      Markdown table -> CSV
  csvkit from html [file]    first <table> in the HTML -> CSV
  csvkit from xml [file]     <root><row><col1>v</col1>...</row>...</root> -> CSV
  csvkit from yaml [file]    YAML list of objects -> CSV  (built-in subset parser)

  --out-delim CHAR           output CSV delimiter (default ,)
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "--out-delim": "string",
    },
  });
  if (args.flags["--help"] || args._.length === 0) { process.stdout.write(HELP); return; }
  const fmt = args._[0];
  const file = args._[1] || "-";
  const outDelim = resolveDelim(args.flags["--out-delim"]) || ",";
  const out = makeWriter(process.stdout);

  if (fmt === "json")  return fromJson(file, outDelim, out);
  if (fmt === "jsonl") return fromJsonl(file, outDelim, out);
  if (fmt === "tsv")   return fromTsv(file, outDelim, out);
  if (fmt === "md")    return fromMd(file, outDelim, out);
  if (fmt === "html")  return fromHtml(file, outDelim, out);
  if (fmt === "xml")   return fromXml(file, outDelim, out);
  if (fmt === "yaml")  return fromYaml(file, outDelim, out);

  process.stderr.write("csvkit from: unknown source format '" + fmt + "'\n");
  process.exit(3);
}

async function fromJson(file, outDelim, out) {
  const text = await readAll(file);
  let v;
  try { v = JSON.parse(text); }
  catch (e) { process.stderr.write("csvkit from json: " + e.message + "\n"); process.exit(2); }
  if (!Array.isArray(v)) { process.stderr.write("csvkit from json: expected an array\n"); process.exit(2); }
  await emitObjects(v, outDelim, out);
  process.stderr.write("csvkit from json . " + v.length + " rows\n");
}

async function fromJsonl(file, outDelim, out) {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const src = file === "-" ? process.stdin : createReadStream(file, { encoding: "utf8" });
  if (src.setEncoding) src.setEncoding("utf8");
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  let header = null;
  let count = 0;
  for await (const raw of rl) {
    if (raw === "") continue;
    let obj;
    try { obj = JSON.parse(raw); }
    catch (_e) { continue; }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) continue;
    const flat = flatten(obj);
    if (header === null) {
      header = Object.keys(flat);
      await out.write(emitRow(header, outDelim) + "\n");
    } else {
      for (const k of Object.keys(flat)) if (header.indexOf(k) === -1) header.push(k);
    }
    const cells = header.map((h) => emitCell(flat[h], outDelim));
    await out.write(cells.join(outDelim) + "\n");
    count++;
  }
  process.stderr.write("csvkit from jsonl . " + count + " rows\n");
}

async function fromTsv(file, outDelim, out) {
  const { parseCsvStream } = await import("../core/csv.js");
  let count = 0;
  for await (const row of parseCsvStream(file, { delim: "\t" })) {
    await out.write(emitRow(row, outDelim) + "\n");
    count++;
  }
  process.stderr.write("csvkit from tsv . " + count + " rows\n");
}

async function fromMd(file, outDelim, out) {
  const text = await readAll(file);
  const rows = parseMdTable(text);
  if (rows.length === 0) {
    process.stderr.write("csvkit from md: no table found\n");
    process.exit(2);
  }
  for (const r of rows) await out.write(emitRow(r, outDelim) + "\n");
  process.stderr.write("csvkit from md . " + (rows.length - 1) + " data rows\n");
}

async function fromHtml(file, outDelim, out) {
  const text = await readAll(file);
  const rows = parseHtmlTable(text);
  if (rows.length === 0) {
    process.stderr.write("csvkit from html: no <table> found\n");
    process.exit(2);
  }
  for (const r of rows) await out.write(emitRow(r, outDelim) + "\n");
  process.stderr.write("csvkit from html . " + (rows.length - 1) + " data rows\n");
}

async function fromXml(file, outDelim, out) {
  const text = await readAll(file);
  const objs = parseXmlRows(text);
  await emitObjects(objs, outDelim, out);
  process.stderr.write("csvkit from xml . " + objs.length + " rows\n");
}

async function fromYaml(file, outDelim, out) {
  const text = await readAll(file);
  const v = parseSimpleYaml(text);
  if (!Array.isArray(v)) {
    process.stderr.write("csvkit from yaml: expected a top-level list of maps\n");
    process.exit(2);
  }
  await emitObjects(v, outDelim, out);
  process.stderr.write("csvkit from yaml . " + v.length + " rows\n");
}

async function emitObjects(arr, outDelim, out) {
  let header = null;
  for (const obj of arr) {
    const flat = obj && typeof obj === "object" ? flatten(obj) : { value: obj };
    if (header === null) {
      header = Object.keys(flat);
      await out.write(emitRow(header, outDelim) + "\n");
    } else {
      for (const k of Object.keys(flat)) if (header.indexOf(k) === -1) header.push(k);
    }
    const cells = header.map((h) => emitCell(flat[h], outDelim));
    await out.write(cells.join(outDelim) + "\n");
  }
}

/* ---------- format parsers ---------- */

function parseMdTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];
  const cells = (l) => {
    let s = l.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim().replace(/\\\|/g, "|"));
  };
  const header = cells(lines[0]);
  const body = lines.slice(1).filter((l) => !/^[\s|:\-]+$/.test(l));
  const rows = [header];
  for (const l of body) rows.push(cells(l));
  return rows;
}

function parseHtmlTable(text) {
  const tableMatch = text.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const inner = tableMatch[1];
  const rows = [];
  for (const trMatch of inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/ig)) {
    const r = [];
    for (const cMatch of trMatch[1].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/ig)) {
      const t = cMatch[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      r.push(t);
    }
    if (r.length > 0) rows.push(r);
  }
  return rows;
}

function parseXmlRows(text) {
  const out = [];
  for (const m of text.matchAll(/<(row|item|record|entry)[^>]*>([\s\S]*?)<\/\1>/ig)) {
    const obj = {};
    for (const cm of m[2].matchAll(/<([A-Za-z_][\w-]*)[^>]*>([\s\S]*?)<\/\1>/ig)) {
      obj[cm[1]] = cm[2]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();
    }
    out.push(obj);
  }
  return out;
}

function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (/^- /.test(raw.trim())) {
      cur = {};
      items.push(cur);
      const rest = raw.replace(/^\s*-\s*/, "");
      if (rest) {
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        if (m) cur[m[1].trim()] = unquote(m[2]);
      }
      continue;
    }
    const m = raw.match(/^\s+([^:]+):\s*(.*)$/);
    if (m && cur) cur[m[1].trim()] = unquote(m[2]);
  }
  return items;
}

function unquote(v) {
  v = v.trim();
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}
