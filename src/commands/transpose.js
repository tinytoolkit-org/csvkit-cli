import { parseCsvStream, emitRow } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit transpose — swap rows and columns

USAGE
  csvkit transpose [file]

NOTE
  Not streamable — loads the whole table into memory.
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
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

  const rows = [];
  let ncols = 0;
  for await (const row of parseCsvStream(file, { delim })) {
    rows.push(row);
    if (row.length > ncols) ncols = row.length;
  }
  const out = makeWriter(process.stdout);
  for (let c = 0; c < ncols; c++) {
    const newRow = rows.map((r) => (r[c] == null ? "" : r[c]));
    await out.write(emitRow(newRow, outDelim) + "\n");
  }
}
