import { parseCsvStream, emitRow, emitCell } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit format — pretty-print, minify, or re-quote a CSV

USAGE
  csvkit format [file]              re-emit canonically (single-line cells, minimal quoting)
  csvkit format --beautify [file]   pad columns to the widest value in each
  csvkit format --quote all [file]  quote every field
  csvkit format --quote none        emit without quotes (lossy if cells contain delim/newline)
  csvkit minify                     alias for the default (no padding, no extra quoting)
  csvkit beautify                   alias for --beautify
`;

export async function run(argv, cmd) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--beautify": "bool", "--quote": "string",
    },
  });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }

  const file = args._[0] || "-";
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const noHeader = !!args.flags["--no-header"];
  const beautify = !!args.flags["--beautify"] || cmd === "beautify";
  const quoteMode = args.flags["--quote"] || "auto";

  const out = makeWriter(process.stdout);

  if (beautify) {
    /* Beautify needs all rows in memory to compute column widths. */
    const rows = [];
    for await (const row of parseCsvStream(file, { delim })) rows.push(row);
    if (rows.length === 0) return;
    const ncols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const widths = new Array(ncols).fill(0);
    for (const r of rows) {
      for (let i = 0; i < r.length; i++) {
        const w = String(r[i] == null ? "" : r[i]).length;
        if (w > widths[i]) widths[i] = w;
      }
    }
    for (const r of rows) {
      const cells = [];
      for (let i = 0; i < ncols; i++) {
        const v = String(r[i] == null ? "" : r[i]);
        cells.push(v + " ".repeat(widths[i] - v.length));
      }
      await out.write(cells.join(outDelim === "," ? ", " : outDelim) + "\n");
    }
    return;
  }

  for await (const row of parseCsvStream(file, { delim })) {
    if (quoteMode === "all") {
      const cells = row.map((v) => '"' + String(v == null ? "" : v).split('"').join('""') + '"');
      await out.write(cells.join(outDelim) + "\n");
    } else if (quoteMode === "none") {
      const cells = row.map((v) => String(v == null ? "" : v).replace(new RegExp("[" + outDelim + "\\n\\r\"]", "g"), " "));
      await out.write(cells.join(outDelim) + "\n");
    } else {
      await out.write(emitRow(row, outDelim) + "\n");
    }
  }
}
