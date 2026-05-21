import { installBrokenPipeHandler } from "../core/io.js";
import { sniffFile, sniffText } from "../core/sniff.js";
import { readAll } from "../core/stream.js";
import { parseArgs } from "../cli.js";

const HELP = `csvkit sniff — guess delimiter, quote char, and whether row 1 is a header

USAGE
  csvkit sniff [file]
  csvkit sniff --json [file]
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, { flags: { "--json": "bool" } });
  if (args.flags["--help"]) { process.stdout.write(HELP); return; }

  const file = args._[0] || "-";
  const result = file === "-" ? sniffText(await readAll(file)) : await sniffFile(file);

  if (args.flags["--json"]) {
    process.stdout.write(JSON.stringify({
      delim: result.delim,
      quote: result.quote,
      hasHeader: result.hasHeader,
      sample: result.sample.slice(0, 3),
    }, null, 2) + "\n");
    return;
  }

  const human = (d) => d === "\t" ? "TAB" : d === "," ? "," : d === ";" ? ";" : d === "|" ? "|" : JSON.stringify(d);
  process.stdout.write("delim:     " + human(result.delim) + "\n");
  process.stdout.write("quote:     " + JSON.stringify(result.quote) + "\n");
  process.stdout.write("header:    " + (result.hasHeader ? "yes" : "no") + "\n");
  if (result.sample[0]) process.stdout.write("columns:   " + result.sample[0].length + "\n");
}
