import { parseCsvStream, emitRow, splitList } from "../core/csv.js";
import { sha1Of } from "../core/hash.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit diff — key-aware row diff between two CSVs

USAGE
  csvkit diff --key id a.csv b.csv         row-level diff keyed by 'id'
  csvkit diff --key a,b a.csv b.csv        composite key
  csvkit diff --csv                        emit a unified diff CSV (default is text summary)
  csvkit diff --added | --removed | --changed   emit only rows of that kind

OUTPUT
  default text: summary + per-row notes
  --csv: a CSV with __op (added|removed|changed) and one column per field
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--key": "string", "--csv": "bool",
      "--added": "bool", "--removed": "bool", "--changed": "bool",
    },
  });
  if (args.flags["--help"] || args._.length !== 2) { process.stdout.write(HELP); return; }

  const [aPath, bPath] = args._;
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim) {
    try { delim = (await sniffFile(aPath)).delim; } catch (_e) { delim = ","; }
  }
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const keyCols = splitList(args.flags["--key"] || "");
  if (keyCols.length === 0) {
    process.stderr.write("csvkit diff: --key COL is required\n");
    process.exit(3);
  }

  const aMap = await loadIntoMap(aPath, delim, keyCols);
  const bMap = await loadIntoMap(bPath, delim, keyCols);

  /* unify columns by header from A (extra B columns appended) */
  const header = aMap.header.slice();
  for (const c of bMap.header) if (header.indexOf(c) === -1) header.push(c);

  const wantAdded = !!args.flags["--added"];
  const wantRemoved = !!args.flags["--removed"];
  const wantChanged = !!args.flags["--changed"];
  const filterMode = wantAdded || wantRemoved || wantChanged;

  const added = [], removed = [], changed = [];
  for (const [k, bRow] of bMap.rows) {
    if (!aMap.rows.has(k)) added.push({ key: k, row: bRow });
  }
  for (const [k, aRow] of aMap.rows) {
    if (!bMap.rows.has(k)) removed.push({ key: k, row: aRow });
    else if (rowHash(aRow, aMap.header, header) !== rowHash(bMap.rows.get(k), bMap.header, header)) {
      changed.push({ key: k, a: aRow, b: bMap.rows.get(k) });
    }
  }

  const out = makeWriter(process.stdout);

  if (args.flags["--csv"]) {
    const headerOut = ["__op", ...header];
    await out.write(emitRow(headerOut, outDelim) + "\n");
    const emit = async (op, aRow, srcHeader) => {
      const row = ["" + op];
      for (const col of header) {
        const i = srcHeader.indexOf(col);
        row.push(i >= 0 ? (aRow[i] == null ? "" : aRow[i]) : "");
      }
      await out.write(emitRow(row, outDelim) + "\n");
    };
    if (!filterMode || wantAdded)   for (const { row } of added)   await emit("added", row, bMap.header);
    if (!filterMode || wantRemoved) for (const { row } of removed) await emit("removed", row, aMap.header);
    if (!filterMode || wantChanged) for (const { b }   of changed) await emit("changed", b, bMap.header);
    return;
  }

  /* text summary */
  process.stdout.write("csvkit diff · added " + added.length + " · removed " + removed.length + " · changed " + changed.length + "\n");
  if (!filterMode || wantAdded) for (const { key } of added) process.stdout.write("+ " + key + "\n");
  if (!filterMode || wantRemoved) for (const { key } of removed) process.stdout.write("- " + key + "\n");
  if (!filterMode || wantChanged) {
    for (const { key, a, b } of changed) {
      process.stdout.write("~ " + key + "\n");
      for (const col of header) {
        const ai = aMap.header.indexOf(col);
        const bi = bMap.header.indexOf(col);
        const av = ai >= 0 ? (a[ai] == null ? "" : a[ai]) : "";
        const bv = bi >= 0 ? (b[bi] == null ? "" : b[bi]) : "";
        if (av !== bv) process.stdout.write("    " + col + ": " + JSON.stringify(av) + " → " + JSON.stringify(bv) + "\n");
      }
    }
  }
  process.exit(added.length + removed.length + changed.length === 0 ? 0 : 1);
}

async function loadIntoMap(path, delim, keyCols) {
  const rows = new Map();
  let header = null;
  let keyIdx = null;
  for await (const row of parseCsvStream(path, { delim })) {
    if (header === null) {
      header = row;
      keyIdx = keyCols.map((k) => {
        const i = header.indexOf(k);
        if (i < 0) {
          process.stderr.write("csvkit diff: '" + path + "' missing key column '" + k + "'\n");
          process.exit(3);
        }
        return i;
      });
      continue;
    }
    const key = keyIdx.map((i) => String(row[i] == null ? "" : row[i])).join("\x01");
    rows.set(key, row);
  }
  return { header, rows };
}

function rowHash(row, srcHeader, unifiedHeader) {
  const parts = [];
  for (const col of unifiedHeader) {
    const i = srcHeader.indexOf(col);
    parts.push(i >= 0 ? (row[i] == null ? "" : String(row[i])) : "");
  }
  return sha1Of(parts.join("\x01"));
}
