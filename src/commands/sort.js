import { parseCsvStream, emitRow, splitList } from "../core/csv.js";
import { asNumber, compareNatural } from "../core/coerce.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit sort — sort rows by one or more columns

USAGE
  csvkit sort --key col[,col,-col2] [file]   prefix '-' on a column for descending
  csvkit sort --numeric                       compare keys numerically (mixed: numbers first)
  csvkit sort --natural                       natural sort (img2 before img10)
  csvkit sort --locale                        locale-aware string compare

NOTE
  Loads the whole file into memory (sort is not streamable). For huge inputs
  pre-filter with 'filter' or split-then-merge externally.
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--key": "string",
      "--numeric": "bool", "--natural": "bool", "--locale": "bool",
    },
  });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }

  const file = args._[0] || "-";
  const noHeader = !!args.flags["--no-header"];
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const keys = splitList(args.flags["--key"] || "");
  if (keys.length === 0) {
    process.stderr.write("csvkit sort: --key COL is required (or run 'csvkit sort --help')\n");
    process.exit(3);
  }

  const out = makeWriter(process.stdout);
  let header = null;
  const rows = [];
  for await (const row of parseCsvStream(file, { delim })) {
    if (!noHeader && header === null) { header = row; continue; }
    rows.push(row);
  }
  if (!header) header = rows[0] ? rows[0].map((_c, i) => String(i + 1)) : [];

  const specs = keys.map((k) => {
    const desc = k.startsWith("-");
    const name = desc ? k.slice(1) : k;
    let idx = header.indexOf(name);
    if (idx < 0) {
      const n = Number(name);
      if (Number.isInteger(n) && n >= 1) idx = n - 1;
    }
    if (idx < 0) {
      process.stderr.write("csvkit sort: unknown column '" + name + "'\n");
      process.exit(3);
    }
    return { idx, desc };
  });

  const numeric = !!args.flags["--numeric"];
  const natural = !!args.flags["--natural"];
  const locale = !!args.flags["--locale"];

  rows.sort((a, b) => {
    for (const { idx, desc } of specs) {
      const av = a[idx], bv = b[idx];
      let c = 0;
      if (numeric) {
        const an = asNumber(av), bn = asNumber(bv);
        const aNaN = Number.isNaN(an), bNaN = Number.isNaN(bn);
        if (aNaN && bNaN) c = 0;
        else if (aNaN) c = 1;
        else if (bNaN) c = -1;
        else c = an - bn;
      } else if (natural) {
        c = compareNatural(av, bv);
      } else if (locale) {
        c = String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv));
      } else {
        const sa = String(av == null ? "" : av), sb = String(bv == null ? "" : bv);
        c = sa < sb ? -1 : (sa > sb ? 1 : 0);
      }
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });

  if (!noHeader) await out.write(emitRow(header, outDelim) + "\n");
  for (const row of rows) await out.write(emitRow(row, outDelim) + "\n");
}
