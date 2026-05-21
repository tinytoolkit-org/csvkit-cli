import { parseCsvStream, emitRow } from "../core/csv.js";
import { installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";
import { createWriteStream } from "node:fs";
import { dirname, basename, extname, join } from "node:path";

const HELP = `csvkit split — write a CSV out as multiple files

USAGE
  csvkit split --rows N [file]           N data rows per output file
  csvkit split --by COLUMN [file]        one file per distinct value in COLUMN
  csvkit split --prefix PATH/name        output path prefix (default: input filename)
  csvkit split --no-header               do not propagate the header to each piece

OUTPUT
  --rows 1000 data.csv  →  data-001.csv, data-002.csv, ...
  --by status orders.csv  →  orders-paid.csv, orders-pending.csv, ...
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--rows": "number", "--by": "string", "--prefix": "string",
    },
  });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }
  if (args.flags["--rows"] === undefined && !args.flags["--by"]) {
    process.stdout.write(HELP);
    process.exit(3);
  }

  const file = args._[0];
  if (!file || file === "-") {
    process.stderr.write("csvkit split: requires a real file (not stdin)\n");
    process.exit(3);
  }
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim) {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const noHeader = !!args.flags["--no-header"];

  const ext = extname(file) || ".csv";
  const base = args.flags["--prefix"] || join(dirname(file), basename(file, ext));

  let header = null;

  if (args.flags["--rows"] !== undefined) {
    const perFile = args.flags["--rows"];
    let part = 0;
    let cur = null;
    let inFile = 0;
    const partName = (n) => base + "-" + String(n).padStart(3, "0") + ext;

    for await (const row of parseCsvStream(file, { delim })) {
      if (!noHeader && header === null) { header = row; continue; }
      if (cur === null || inFile >= perFile) {
        if (cur) cur.end();
        part++;
        cur = createWriteStream(partName(part), { encoding: "utf8" });
        if (header) cur.write(emitRow(header, outDelim) + "\n");
        inFile = 0;
      }
      cur.write(emitRow(row, outDelim) + "\n");
      inFile++;
    }
    if (cur) cur.end();
    process.stderr.write("csvkit split · " + part + " files written (" + perFile + " rows each)\n");
    return;
  }

  /* --by COLUMN */
  const byCol = args.flags["--by"];
  let colIdx = -1;
  const writers = new Map();

  for await (const row of parseCsvStream(file, { delim })) {
    if (!noHeader && header === null) {
      header = row;
      colIdx = header.indexOf(byCol);
      if (colIdx < 0) {
        process.stderr.write("csvkit split: unknown column '" + byCol + "'\n");
        process.exit(3);
      }
      continue;
    }
    if (header === null) {
      header = row.map((_c, i) => String(i + 1));
      colIdx = header.indexOf(byCol);
      if (colIdx < 0) {
        const n = Number(byCol);
        if (Number.isInteger(n) && n >= 1) colIdx = n - 1;
      }
      if (colIdx < 0) {
        process.stderr.write("csvkit split: unknown column '" + byCol + "'\n");
        process.exit(3);
      }
    }
    const key = sanitize(row[colIdx] == null ? "" : row[colIdx]);
    let w = writers.get(key);
    if (!w) {
      w = createWriteStream(base + "-" + key + ext, { encoding: "utf8" });
      if (header && !noHeader) w.write(emitRow(header, outDelim) + "\n");
      writers.set(key, w);
    }
    w.write(emitRow(row, outDelim) + "\n");
  }
  for (const w of writers.values()) w.end();
  process.stderr.write("csvkit split · " + writers.size + " files (one per distinct '" + byCol + "')\n");
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_") || "empty";
}
