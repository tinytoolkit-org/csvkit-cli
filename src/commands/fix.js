import { parseCsvStream, emitRow } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { readAll } from "../core/stream.js";
import { preNormalize } from "../core/fix.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit fix — auto-repair common CSV breakages

Repairs:
  - UTF-8 BOM, CRLF / CR line endings
  - smart quotes ‘ ’ “ ” → ' "
  - ragged rows: pads short rows with empty cells, truncates over-long rows
  - mixed quoting (drops stray non-opening quotes if a row fails to parse)
  - non-breaking spaces inside cells

USAGE
  csvkit fix [file]              writes a clean CSV to stdout
  --keep-ragged                  don't pad/truncate ragged rows
  --json-report                  emit a JSON summary on stderr
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string",
      "--out-delim": "string",
      "--no-header": "bool",
      "--keep-ragged": "bool", "--json-report": "bool",
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
  const keepRagged = !!args.flags["--keep-ragged"];

  /* Normalise the whole input first to handle smart-quote and nbsp.
     CSV inputs are usually small enough; for huge files users can run a
     streaming normalisation upstream. */
  const text = preNormalize(await readAll(file));

  const out = makeWriter(process.stdout);
  let width = null;
  let header = null;
  let total = 0, padded = 0, truncated = 0;

  /* feed the pre-normalised text through the parser */
  const fakeStream = (async function* () { yield text; })();
  for await (const row of parseCsvStream(fakeStream, { delim })) {
    total++;
    if (!noHeader && header === null) {
      header = row;
      width = row.length;
      await out.write(emitRow(row, outDelim) + "\n");
      continue;
    }
    if (width === null) width = row.length;
    let r = row;
    if (!keepRagged && r.length !== width) {
      if (r.length < width) {
        r = r.slice();
        while (r.length < width) r.push("");
        padded++;
      } else {
        r = r.slice(0, width);
        truncated++;
      }
    }
    await out.write(emitRow(r, outDelim) + "\n");
  }

  if (args.flags["--json-report"]) {
    process.stderr.write(JSON.stringify({ total, padded, truncated }) + "\n");
  } else {
    process.stderr.write("csvkit fix · " + total + " rows · " + padded + " padded · " + truncated + " truncated\n");
  }
}
