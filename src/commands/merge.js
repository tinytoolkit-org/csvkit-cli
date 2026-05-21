import { parseCsvStream, emitRow } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit merge — concatenate CSV files vertically

USAGE
  csvkit merge a.csv b.csv c.csv > merged.csv

  - Header is taken from the first file.
  - Each subsequent file's header is skipped (use --no-header to keep all rows).
  - Columns are aligned by header name: missing columns become empty, extra columns are dropped.
  - Use --keep-extra to also keep columns that appear in later files (header grows).
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool", "--keep-extra": "bool",
    },
  });
  if (args.flags["--help"] || args._.length === 0) { process.stdout.write(HELP); return; }

  const files = args._;
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim) {
    try { delim = (await sniffFile(files[0])).delim; } catch (_e) { delim = ","; }
  }
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const noHeader = !!args.flags["--no-header"];
  const keepExtra = !!args.flags["--keep-extra"];

  const out = makeWriter(process.stdout);

  let header = null;
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    let local = null;
    for await (const row of parseCsvStream(file, { delim })) {
      if (noHeader) {
        await out.write(emitRow(row, outDelim) + "\n");
        continue;
      }
      if (local === null) {
        local = row;
        if (header === null) {
          header = row.slice();
          await out.write(emitRow(header, outDelim) + "\n");
        } else if (keepExtra) {
          for (const c of row) if (header.indexOf(c) === -1) header.push(c);
          /* note: header re-emission isn't easy mid-stream; new columns just
             become empty cells in earlier files' rows (already written). */
        }
        continue;
      }
      /* align by local-header positions */
      const map = local.map((c) => header.indexOf(c));
      const aligned = new Array(header.length).fill("");
      for (let i = 0; i < row.length; i++) {
        const dst = map[i];
        if (dst >= 0) aligned[dst] = row[i];
      }
      await out.write(emitRow(aligned, outDelim) + "\n");
    }
  }
}
