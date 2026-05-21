import { parseCsvStream } from "../core/csv.js";
import { installBrokenPipeHandler } from "../core/io.js";
import { createProgress } from "../core/progress.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit count — count rows

USAGE
  csvkit count [file]              count data rows (excludes the header by default)
  csvkit count --no-header [file]  count every row
  csvkit count --json [file]       emit { rows, header } as JSON
  csvkit count --progress          progress meter on stderr
  -d, --delim CHAR                 input delimiter (auto-detected on real files)
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim",
      "--delim": "string",
      "--no-header": "bool",
      "--json": "bool",
      "--progress": "bool",
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

  const progress = createProgress("count", { enabled: !!args.flags["--progress"] });
  let rows = 0;
  for await (const _row of parseCsvStream(file, { delim })) {
    rows++;
    progress.bumpRecord(0);
  }
  progress.finish();

  const dataRows = noHeader ? rows : Math.max(0, rows - 1);
  if (args.flags["--json"]) {
    process.stdout.write(JSON.stringify({ rows: dataRows, header: !noHeader }) + "\n");
  } else {
    process.stdout.write(dataRows + "\n");
  }
}
