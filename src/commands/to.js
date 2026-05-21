import { parseCsvStream, rowToObject } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit to — convert CSV to another format

USAGE
  csvkit to json [file]      one big JSON array; --pretty for indented
  csvkit to jsonl [file]     newline-delimited JSON (one row per line)
  csvkit to tsv [file]       TSV
  csvkit to md [file]        a GitHub-flavored Markdown table
  csvkit to html [file]      a single <table>; --full for a standalone HTML doc
  csvkit to sql [file]       INSERT statements; --table NAME (default 'data')
                             --dialect mysql|postgres|sqlite|mssql (default mysql)
                             --create  also emit CREATE TABLE with inferred types
  csvkit to xml [file]       <rows><row><col>v</col>...</row></rows>
  csvkit to yaml [file]      list of mappings

  --types auto|string|blank-null   value coercion (default auto)
  --nest dot                       expand dotted headers into nested objects (json/yaml/xml)
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string",
      "--pretty": "bool", "--full": "bool",
      "--table": "string", "--dialect": "string", "--create": "bool",
      "--types": "string", "--nest": "string",
      "--no-header": "bool",
    },
  });
  if (args.flags["--help"] || args._.length === 0) { process.stdout.write(HELP); return; }

  const fmt = args._[0];
  const file = args._[1] || "-";
  const noHeader = !!args.flags["--no-header"];
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";

  const out = makeWriter(process.stdout);
  const types = args.flags["--types"] || "auto";
  const nest = args.flags["--nest"] || "flat";

  /* shared: iterate rows with a synthetic header if --no-header */
  const stream = parseCsvStream(file, { delim });
  let header = null;
  const synthName = (i) => "col" + (i + 1);

  if (fmt === "json")  return toJson(stream, args.flags, types, nest, noHeader, out);
  if (fmt === "jsonl") return toJsonl(stream, types, nest, noHeader, out);
  if (fmt === "tsv")   return toTsv(stream, noHeader, out);
  if (fmt === "md")    return toMd(stream, noHeader, out);
  if (fmt === "html")  return toHtml(stream, args.flags, noHeader, out);
  if (fmt === "sql")   return toSql(stream, args.flags, noHeader, out);
  if (fmt === "xml")   return toXml(stream, types, nest, noHeader, out);
  if (fmt === "yaml")  return toYaml(stream, types, nest, noHeader, out);

  process.stderr.write("csvkit to: unknown target format '" + fmt + "'\n");
  process.exit(3);
}

async function toJson(stream, flags, types, nest, noHeader, out) {
  const pretty = !!flags["--pretty"];
  let header = null;
  let first = true;
  await out.write("[" + (pretty ? "\n" : ""));
  for await (const row of stream) {
    if (!noHeader && header === null) { header = row; continue; }
    if (header === null) header = row.map((_c, i) => "col" + (i + 1));
    const obj = rowToObject(header, row, { types, nest });
    if (!first) await out.write("," + (pretty ? "\n" : ""));
    const s = JSON.stringify(obj, null, pretty ? 2 : 0);
    await out.write(pretty ? indentBlock(s, "  ") : s);
    first = false;
  }
  await out.write((pretty && !first ? "\n" : "") + "]\n");
}

async function toJsonl(stream, types, nest, noHeader, out) {
  let header = null;
  for await (const row of stream) {
    if (!noHeader && header === null) { header = row; continue; }
    if (header === null) header = row.map((_c, i) => "col" + (i + 1));
    const obj = rowToObject(header, row, { types, nest });
    await out.write(JSON.stringify(obj) + "\n");
  }
}

async function toTsv(stream, noHeader, out) {
  const { emitRow } = await import("../core/csv.js");
  let header = null;
  for await (const row of stream) {
    if (!noHeader && header === null) {
      header = row;
      await out.write(emitRow(row, "\t") + "\n");
      continue;
    }
    await out.write(emitRow(row, "\t") + "\n");
  }
}

async function toMd(stream, noHeader, out) {
  let header = null;
  for await (const row of stream) {
    if (!noHeader && header === null) {
      header = row;
      await out.write("| " + row.map(mdEsc).join(" | ") + " |\n");
      await out.write("|" + row.map(() => "---").join("|") + "|\n");
      continue;
    }
    await out.write("| " + row.map(mdEsc).join(" | ") + " |\n");
  }
}

async function toHtml(stream, flags, noHeader, out) {
  const full = !!flags["--full"];
  if (full) await out.write("<!doctype html>\n<html><head><meta charset=\"utf-8\"></head><body>\n");
  await out.write("<table>\n");
  let header = null;
  for await (const row of stream) {
    if (!noHeader && header === null) {
      header = row;
      await out.write("  <thead><tr>" + row.map((c) => "<th>" + htmlEsc(c) + "</th>").join("") + "</tr></thead>\n  <tbody>\n");
      continue;
    }
    if (header === null) {
      header = row.map((_c, i) => "col" + (i + 1));
      await out.write("  <tbody>\n");
    }
    await out.write("    <tr>" + row.map((c) => "<td>" + htmlEsc(c) + "</td>").join("") + "</tr>\n");
  }
  await out.write("  </tbody>\n</table>\n");
  if (full) await out.write("</body></html>\n");
}

async function toSql(stream, flags, noHeader, out) {
  const tableName = flags["--table"] || "data";
  const dialect = (flags["--dialect"] || "mysql").toLowerCase();
  const create = !!flags["--create"];
  const { inferType } = await import("../core/coerce.js");

  let header = null;
  const rows = [];
  for await (const row of stream) {
    if (!noHeader && header === null) { header = row; continue; }
    if (header === null) header = row.map((_c, i) => "col" + (i + 1));
    rows.push(row);
  }
  if (!header) return;

  if (create) {
    const types = header.map((_h, ci) => {
      const seen = new Set();
      for (const r of rows) seen.add(inferType(r[ci] == null ? "" : r[ci]));
      seen.delete("null");
      if (seen.size === 1) {
        const t = seen.values().next().value;
        return { integer: "INTEGER", number: "DOUBLE", boolean: "BOOLEAN", date: "DATE", datetime: "TIMESTAMP", string: "TEXT" }[t] || "TEXT";
      }
      return "TEXT";
    });
    await out.write("CREATE TABLE " + qIdent(tableName, dialect) + " (\n");
    await out.write(header.map((h, i) => "  " + qIdent(h, dialect) + " " + types[i]).join(",\n") + "\n");
    await out.write(");\n");
  }

  const cols = header.map((h) => qIdent(h, dialect)).join(", ");
  for (const r of rows) {
    const values = header.map((_h, i) => sqlLit(r[i] == null ? "" : r[i], dialect)).join(", ");
    await out.write("INSERT INTO " + qIdent(tableName, dialect) + " (" + cols + ") VALUES (" + values + ");\n");
  }
}

async function toXml(stream, types, nest, noHeader, out) {
  let header = null;
  await out.write('<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n');
  for await (const row of stream) {
    if (!noHeader && header === null) { header = row; continue; }
    if (header === null) header = row.map((_c, i) => "col" + (i + 1));
    const obj = rowToObject(header, row, { types, nest });
    await out.write("  <row>\n");
    for (const [k, v] of Object.entries(obj)) {
      await out.write("    <" + safeTag(k) + ">" + xmlEsc(v) + "</" + safeTag(k) + ">\n");
    }
    await out.write("  </row>\n");
  }
  await out.write("</rows>\n");
}

async function toYaml(stream, types, nest, noHeader, out) {
  let header = null;
  for await (const row of stream) {
    if (!noHeader && header === null) { header = row; continue; }
    if (header === null) header = row.map((_c, i) => "col" + (i + 1));
    const obj = rowToObject(header, row, { types, nest });
    await out.write("- " + yamlPairs(obj, 2) + "\n");
  }
}

/* ---------- helpers ---------- */

function indentBlock(s, prefix) {
  return s.split("\n").map((line) => prefix + line).join("\n");
}
function mdEsc(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function htmlEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function xmlEsc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function safeTag(k) {
  return String(k).replace(/[^A-Za-z0-9_.-]/g, "_") || "col";
}
function qIdent(name, dialect) {
  if (dialect === "mysql") return "`" + String(name).replace(/`/g, "``") + "`";
  if (dialect === "mssql") return "[" + String(name).replace(/]/g, "]]") + "]";
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function sqlLit(v, _dialect) {
  if (v === "" || v == null) return "NULL";
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (s === "true" || s === "false") return s.toUpperCase();
  return "'" + s.replace(/'/g, "''") + "'";
}
function yamlPairs(obj, indent) {
  const lines = [];
  let first = true;
  for (const [k, v] of Object.entries(obj)) {
    if (first) { lines.push(k + ": " + yamlVal(v)); first = false; }
    else lines.push(" ".repeat(indent) + k + ": " + yamlVal(v));
  }
  return lines.join("\n");
}
function yamlVal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "" || /[:#\-{}\[\],&*!|>'"%@`]|^\s|\s$/.test(s)) {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return s;
}
