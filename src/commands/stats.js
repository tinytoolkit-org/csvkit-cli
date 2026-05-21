import { parseCsvStream } from "../core/csv.js";
import { createColumnAccumulator, addCell, summarize, humanBytes } from "../core/stats.js";
import { installBrokenPipeHandler } from "../core/io.js";
import { createProgress } from "../core/progress.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";
import { stat } from "node:fs/promises";

const HELP = `csvkit stats — per-column type, nulls, unique, min/max

USAGE
  csvkit stats [file]
  csvkit stats --json [file]   machine-readable JSON
  csvkit stats --col NAME      restrict to one column
  csvkit stats --progress      live rows/sec on stderr
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string",
      "--no-header": "bool",
      "--json": "bool", "--col": "string", "--progress": "bool",
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

  const progress = createProgress("stats", { enabled: !!args.flags["--progress"] });

  let header = null;
  let accs = [];
  let rowCount = 0;

  for await (const row of parseCsvStream(file, { delim })) {
    if (!noHeader && header === null) {
      header = row;
      accs = header.map(() => createColumnAccumulator());
      continue;
    }
    if (header === null) {
      header = row.map((_c, i) => "col" + (i + 1));
      accs = header.map(() => createColumnAccumulator());
    }
    rowCount++;
    progress.bumpRecord(0);
    for (let i = 0; i < row.length; i++) {
      if (i >= accs.length) {
        /* extra columns past header — extend on the fly */
        header.push("col" + (i + 1));
        accs.push(createColumnAccumulator());
      }
      addCell(accs[i], row[i]);
    }
    /* short rows: treat missing cells as null */
    for (let i = row.length; i < header.length; i++) addCell(accs[i], "");
  }
  progress.finish();

  if (header === null) {
    process.stderr.write("csvkit stats: empty input\n");
    process.exit(2);
  }

  let bytes = null;
  if (file !== "-") {
    try { bytes = (await stat(file)).size; } catch (_e) {}
  }

  const summary = header.map((name, i) => ({ name, ...summarize(accs[i]) }));
  const onlyCol = args.flags["--col"];
  const filtered = onlyCol ? summary.filter((s) => s.name === onlyCol) : summary;

  if (args.flags["--json"]) {
    process.stdout.write(JSON.stringify({
      rows: rowCount, bytes, columns: filtered,
    }, null, 2) + "\n");
    return;
  }

  const out = [];
  out.push("rows:    " + rowCount);
  if (bytes !== null) out.push("bytes:   " + bytes + " (" + humanBytes(bytes) + ")");
  out.push("columns: " + header.length);
  out.push("");
  out.push(pad("column", 24) + pad("type", 12) + pad("nulls", 8) + pad("unique", 10) + pad("min", 14) + pad("max", 14));
  out.push("-".repeat(82));
  for (const s of filtered) {
    const typeStr = topType(s.types);
    const uniq = s.unique == null ? ">" + 50000 : String(s.unique);
    const minS = s.min == null ? "" : String(s.min);
    const maxS = s.max == null ? "" : String(s.max);
    out.push(pad(s.name, 24) + pad(typeStr, 12) + pad(s.nulls, 8) + pad(uniq, 10) + pad(minS, 14) + pad(maxS, 14));
  }
  process.stdout.write(out.join("\n") + "\n");
}

function topType(types) {
  let best = "string", bestN = -1;
  for (const [t, n] of Object.entries(types)) {
    if (n > bestN) { best = t; bestN = n; }
  }
  return best;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}
