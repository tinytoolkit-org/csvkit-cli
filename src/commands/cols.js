import { parseCsvStream, emitRow, splitList } from "../core/csv.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit cols — keep, drop, rename, or reorder columns

USAGE
  csvkit cols --keep a,b,c [file]          keep only these columns (preserves order given)
  csvkit cols --drop x,y [file]            drop these columns
  csvkit cols --order b,a,c [file]         reorder (extra columns appended in original order)
  csvkit cols --rename old:new,o2:n2 [f]   rename columns
  csvkit cols --list [file]                just print the header, one column per line

  Columns can be referenced by name or 1-indexed position.
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--keep": "string", "--drop": "string", "--order": "string",
      "--rename": "string", "--list": "bool",
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

  const keep = splitList(args.flags["--keep"] || "");
  const drop = splitList(args.flags["--drop"] || "");
  const order = splitList(args.flags["--order"] || "");
  const rename = parseRenameMap(args.flags["--rename"] || "");

  const out = makeWriter(process.stdout);
  let header = null;
  let indices = null;   // index map: outIdx -> inIdx
  let outHeader = null;

  const resolve = (h, spec) => {
    const i = h.indexOf(spec);
    if (i >= 0) return i;
    const n = Number(spec);
    if (Number.isInteger(n) && n >= 1 && n <= h.length) return n - 1;
    return -1;
  };

  for await (const row of parseCsvStream(file, { delim })) {
    if (header === null) {
      header = noHeader ? row.map((_c, i) => String(i + 1)) : row;
      const renamed = header.map((h) => Object.prototype.hasOwnProperty.call(rename, h) ? rename[h] : h);

      if (keep.length > 0) {
        indices = keep.map((k) => resolve(header, k)).filter((i) => i >= 0);
      } else if (drop.length > 0) {
        const dropSet = new Set(drop.map((d) => resolve(header, d)).filter((i) => i >= 0));
        indices = header.map((_h, i) => i).filter((i) => !dropSet.has(i));
      } else if (order.length > 0) {
        const explicit = order.map((k) => resolve(header, k)).filter((i) => i >= 0);
        const rest = header.map((_h, i) => i).filter((i) => !explicit.includes(i));
        indices = explicit.concat(rest);
      } else {
        indices = header.map((_h, i) => i);
      }
      outHeader = indices.map((i) => renamed[i]);

      if (args.flags["--list"]) {
        process.stdout.write(outHeader.join("\n") + "\n");
        return;
      }
      if (!noHeader) await out.write(emitRow(outHeader, outDelim) + "\n");
      if (noHeader) {
        /* the first row is data — also emit projected */
        const projected = indices.map((i) => row[i] == null ? "" : row[i]);
        await out.write(emitRow(projected, outDelim) + "\n");
      }
      continue;
    }
    const projected = indices.map((i) => row[i] == null ? "" : row[i]);
    await out.write(emitRow(projected, outDelim) + "\n");
  }
}

function parseRenameMap(spec) {
  const out = {};
  if (!spec) return out;
  for (const part of spec.split(",")) {
    const [from, to] = part.split(":");
    if (from && to) out[from.trim()] = to.trim();
  }
  return out;
}
