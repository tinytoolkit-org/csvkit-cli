import { parseCsvStream, emitRow } from "../core/csv.js";
import { compileExpression } from "../core/filter-expr.js";
import { makeWriter, installBrokenPipeHandler } from "../core/io.js";
import { sniffFile } from "../core/sniff.js";
import { parseArgs, resolveDelim } from "../cli.js";

const HELP = `csvkit filter — keep rows matching a SQL-WHERE-style expression

USAGE
  csvkit filter --where "EXPR" [file]
  csvkit filter --invert  emit non-matching rows instead

EXPRESSION
  column refs:   age   \`first name\`   email
  literals:      42  3.14  'hello'  true  false  null
  comparison:    = != < <= > >=        (numeric when both sides parse as numbers)
  pattern:       name LIKE 'A%'        % wildcard, _ single char
  membership:    role IN ('admin','editor')
  null:          email IS NULL  /  email IS NOT NULL
  logic:         AND  OR  NOT  ( )

EXAMPLES
  csvkit filter --where "amount > 100 AND status = 'paid'" txns.csv
  csvkit filter --where "name LIKE 'Al%'" people.csv
  csvkit filter --where "age IS NOT NULL" data.csv
`;

export async function run(argv) {
  installBrokenPipeHandler();
  const args = parseArgs(argv, {
    flags: {
      "-d": "--delim", "--delim": "string", "--out-delim": "string",
      "--no-header": "bool",
      "--where": "string", "--invert": "bool",
    },
  });
  if (args.flags["--help"] || !args.flags["--where"]) { process.stdout.write(HELP); return; }

  const file = args._[0] || "-";
  const noHeader = !!args.flags["--no-header"];
  let delim = resolveDelim(args.flags["--delim"]);
  if (!delim && file !== "-") {
    try { delim = (await sniffFile(file)).delim; } catch (_e) { delim = ","; }
  }
  if (!delim) delim = ",";
  const outDelim = resolveDelim(args.flags["--out-delim"]) || delim;
  const invert = !!args.flags["--invert"];

  const out = makeWriter(process.stdout);
  let header = null;
  let predicate = null;
  let kept = 0, total = 0;

  for await (const row of parseCsvStream(file, { delim })) {
    if (!noHeader && header === null) {
      header = row;
      try {
        predicate = compileExpression(args.flags["--where"], header);
      } catch (e) {
        process.stderr.write("csvkit filter: " + e.message + "\n");
        process.exit(3);
      }
      await out.write(emitRow(row, outDelim) + "\n");
      continue;
    }
    if (header === null) {
      header = row.map((_c, i) => "col" + (i + 1));
      try {
        predicate = compileExpression(args.flags["--where"], header);
      } catch (e) {
        process.stderr.write("csvkit filter: " + e.message + "\n");
        process.exit(3);
      }
    }
    total++;
    let match = false;
    try { match = predicate(row); } catch (_e) { match = false; }
    if (invert) match = !match;
    if (match) {
      await out.write(emitRow(row, outDelim) + "\n");
      kept++;
    }
  }
  process.stderr.write("csvkit filter · " + kept + "/" + total + " rows matched\n");
}
