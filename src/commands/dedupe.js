import { parseCsvStream, emitRow, splitList } from "../core/csv.js";
import { sha1OfRow, sha1Of } from "../core/hash.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit dedupe — drop duplicate rows

USAGE
  csvkit dedupe [file]               full-row dedup (sha1 of every cell)
  csvkit dedupe --key COL[,COL2]     dedupe by one or more columns
  csvkit dedupe --keep first|last    which copy to keep (default first; 'last' buffers in memory)
  csvkit dedupe --case-insensitive   compare keys case-insensitively
  csvkit dedupe --trim               trim whitespace before comparing
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--key": "string", "--keep": "string",
      "--case-insensitive": "bool", "--trim": "bool",
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
  const keepLast = args.flags["--keep"] === "last";
  const ci = !!args.flags["--case-insensitive"];
  const trim = !!args.flags["--trim"];

  const out = makeWriter(process.stdout);
  let header = null;
  let keyIdx = null;

  const normalise = (v) => {
    let s = v == null ? "" : String(v);
    if (trim) s = s.trim();
    if (ci) s = s.toLowerCase();
    return s;
  };

  const hashOf = (row) => {
    if (keys.length === 0) {
      return sha1OfRow(row.map(normalise));
    }
    const parts = keyIdx.map((i) => normalise(row[i]));
    return sha1Of(parts.join("\x01"));
  };

  let total = 0, kept = 0, dropped = 0;
  const seen = new Set();
  const buffered = keepLast ? new Map() : null;

  for await (const row of parseCsvStream(file, { delim })) {
    if (!noHeader && header === null) {
      header = row;
      await out.write(emitRow(row, outDelim) + "\n");
      if (keys.length > 0) {
        keyIdx = keys.map((k) => {
          const i = header.indexOf(k);
          if (i < 0) {
            process.stderr.write("csvkit dedupe: unknown column '" + k + "'\n");
            process.exit(3);
          }
          return i;
        });
      }
      continue;
    }
    if (header === null) {
      header = row.map((_c, i) => String(i + 1));
      if (keys.length > 0) {
        keyIdx = keys.map((k) => Number(k) - 1);
      }
    }
    total++;
    const h = hashOf(row);
    if (keepLast) {
      buffered.set(h, row);
    } else if (seen.has(h)) {
      dropped++;
    } else {
      seen.add(h);
      await out.write(emitRow(row, outDelim) + "\n");
      kept++;
    }
  }

  if (keepLast) {
    for (const row of buffered.values()) {
      await out.write(emitRow(row, outDelim) + "\n");
      kept++;
    }
    dropped = total - kept;
  }

  process.stderr.write("csvkit dedupe · " + total + " rows · " + kept + " kept · " + dropped + " dropped\n");
}
