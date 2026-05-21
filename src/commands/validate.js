import { parseCsvStream } from "../core/csv.js";
import { installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit validate — strict RFC 4180 check + structural rules

CHECKS
  - every row has the same number of fields as the header
  - no unterminated quoted fields
  - --required col[,col]    every value non-empty in these columns
  - --unique col[,col]      values must be unique across the file
  - --type col:type[,...]   per-column type check (integer|number|boolean|date|datetime|string)
  - --max-rows N            fail if more rows than N
  - --max-cell-bytes N      fail if any cell exceeds N bytes

USAGE
  csvkit validate [flags] [file]
  --quiet         suppress per-row ok output
  --json-errors   emit one JSON object per error to stderr

EXIT CODES
  0 clean, 1 errors, 2 read error
`;

import { inferType } from "../core/coerce.js";

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string",
      "--no-header": "bool",
      "--required": "string", "--unique": "string", "--type": "string",
      "--max-rows": "number", "--max-cell-bytes": "number",
      "--quiet": "bool", "--json-errors": "bool",
    },
  });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }

  const file = args._[0] || "-";
  const noHeader = !!args.flags["--no-header"];
  const quiet = !!args.flags["--quiet"];
  const jsonErrors = !!args.flags["--json-errors"];
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";

  const required = (args.flags["--required"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const unique = (args.flags["--unique"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const typeMap = parseTypeMap(args.flags["--type"] || "");
  const maxRows = args.flags["--max-rows"];
  const maxCellBytes = args.flags["--max-cell-bytes"];

  let header = null;
  let rowNum = 0; // CSV row number including header
  let dataRow = 0;
  let errors = 0;
  const uniqueSeen = new Map(); // colIdx -> Set

  const emit = (row, msg) => {
    errors++;
    if (jsonErrors) process.stderr.write(JSON.stringify({ row, error: msg }) + "\n");
    else process.stderr.write("row " + row + ": " + msg + "\n");
  };

  for await (const r of parseCsvStream(file, { delim })) {
    rowNum++;
    if (header === null) {
      if (noHeader) {
        header = r.map((_c, i) => "col" + (i + 1));
        /* this row IS a data row */
      } else {
        header = r;
        for (const u of unique) uniqueSeen.set(idx(header, u), new Set());
        continue;
      }
    }
    if (r.length !== header.length) emit(rowNum, "ragged row: " + r.length + " fields, expected " + header.length);
    dataRow++;
    for (let i = 0; i < header.length; i++) {
      const cell = r[i] == null ? "" : r[i];
      if (maxCellBytes !== undefined && Buffer.byteLength(cell, "utf8") > maxCellBytes) {
        emit(rowNum, "cell " + (i + 1) + " exceeds --max-cell-bytes");
      }
      if (required.indexOf(header[i]) !== -1 && cell === "") {
        emit(rowNum, "required column '" + header[i] + "' is empty");
      }
      const wantType = typeMap[header[i]];
      if (wantType && cell !== "") {
        const t = inferType(cell);
        if (!typeMatches(t, wantType)) {
          emit(rowNum, "column '" + header[i] + "' expected " + wantType + " but got " + JSON.stringify(cell));
        }
      }
      if (uniqueSeen.has(i)) {
        const seen = uniqueSeen.get(i);
        if (seen.has(cell)) emit(rowNum, "duplicate '" + cell + "' in unique column '" + header[i] + "'");
        else seen.add(cell);
      }
    }
    if (maxRows !== undefined && dataRow > maxRows) {
      emit(rowNum, "exceeds --max-rows " + maxRows);
      break;
    }
  }

  if (!quiet) {
    process.stderr.write("csvkit validate · " + dataRow + " data rows · " + errors + " errors\n");
  }
  process.exit(errors === 0 ? 0 : 1);
}

function idx(header, name) {
  const i = header.indexOf(name);
  return i >= 0 ? i : -1;
}

function parseTypeMap(spec) {
  const out = {};
  if (!spec) return out;
  for (const part of spec.split(",")) {
    const [k, v] = part.split(":");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function typeMatches(actual, expected) {
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  if (expected === "boolean") return actual === "boolean";
  if (expected === "date") return actual === "date" || actual === "datetime";
  if (expected === "datetime") return actual === "datetime";
  if (expected === "string") return true;
  return false;
}
