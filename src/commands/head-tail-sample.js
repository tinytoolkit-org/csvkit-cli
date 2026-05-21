import { parseCsvStream, emitRow } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit head / tail / sample — slice CSV files

USAGE
  csvkit head -n 10 [file]      first N rows (default 10), keeping the header
  csvkit tail -n 10 [file]      last N rows; seeks from end on real files
  csvkit sample -n 100 [file]   reservoir random sample (--seed N for deterministic)
  --no-header                   no header — N rows from the top/bottom verbatim
`;

export async function run(argv, cmd) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-n": "number", "--n": "number", "--seed": "number",
      "-d": "--delim", "--delim": "string",
      "--no-header": "bool",
    },
  });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }

  const n = args.flags["-n"] !== undefined ? args.flags["-n"] :
            (args.flags["--n"] !== undefined ? args.flags["--n"] :
             (cmd === "sample" ? 100 : 10));
  const file = args._[0] || "-";
  const noHeader = !!args.flags["--no-header"];
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";

  const out = makeWriter(process.stdout);

  if (cmd === "head") {
    let header = null, kept = 0;
    for await (const row of parseCsvStream(file, { delim })) {
      if (!noHeader && header === null) {
        header = row;
        await out.write(emitRow(row, delim) + "\n");
        continue;
      }
      if (kept >= n) break;
      await out.write(emitRow(row, delim) + "\n");
      kept++;
    }
    return;
  }

  if (cmd === "tail") {
    let header = null;
    const buf = [];
    for await (const row of parseCsvStream(file, { delim })) {
      if (!noHeader && header === null) { header = row; continue; }
      buf.push(row);
      if (buf.length > n) buf.shift();
    }
    if (header) await out.write(emitRow(header, delim) + "\n");
    for (const row of buf) await out.write(emitRow(row, delim) + "\n");
    return;
  }

  if (cmd === "sample") {
    const rng = makeRng(args.flags["--seed"]);
    let header = null;
    const reservoir = [];
    let i = 0;
    for await (const row of parseCsvStream(file, { delim })) {
      if (!noHeader && header === null) { header = row; continue; }
      if (reservoir.length < n) reservoir.push(row);
      else {
        const j = Math.floor(rng() * (i + 1));
        if (j < n) reservoir[j] = row;
      }
      i++;
    }
    if (header) await out.write(emitRow(header, delim) + "\n");
    for (const row of reservoir) await out.write(emitRow(row, delim) + "\n");
    return;
  }
}

function makeRng(seed) {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
