/**
 * Top-level CLI dispatcher.
 * Usage:  csvkit <command> [flags] [file]
 *         csvkit -h | --help | --version
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const COMMANDS = {
  count:     () => import("./commands/count.js"),
  head:      () => import("./commands/head-tail-sample.js"),
  tail:      () => import("./commands/head-tail-sample.js"),
  sample:    () => import("./commands/head-tail-sample.js"),
  stats:     () => import("./commands/stats.js"),
  validate:  () => import("./commands/validate.js"),
  fix:       () => import("./commands/fix.js"),
  format:    () => import("./commands/format.js"),
  beautify:  () => import("./commands/format.js"),
  minify:    () => import("./commands/format.js"),
  dedupe:    () => import("./commands/dedupe.js"),
  sort:      () => import("./commands/sort.js"),
  filter:    () => import("./commands/filter.js"),
  cols:      () => import("./commands/cols.js"),
  transpose: () => import("./commands/transpose.js"),
  merge:     () => import("./commands/merge.js"),
  split:     () => import("./commands/split.js"),
  diff:      () => import("./commands/diff.js"),
  sniff:     () => import("./commands/sniff.js"),
  from:      () => import("./commands/from.js"),
  to:        () => import("./commands/to.js"),
};

const HELP = `csvkit ${pkg.version} — CSV on the command line

USAGE
  csvkit <command> [flags] [file]      reads stdin if no file given

CORE
  count [file]                fast row count (--header skips header in total)
  stats [file]                per-column: count, nulls, unique, type, min/max
  validate [file]             RFC 4180 strict check; ragged rows, broken quotes
  fix [file]                  BOM, smart quotes, CRLF, unterminated quotes, ragged rows
  format [file]               --beautify (align) | --minify | --quote all
  head [-n 10] [file]         first N rows
  tail [-n 10] [file]         last N rows — seeks from end on real files
  sample [-n 100 --seed N]    reservoir random sample (one pass, deterministic with --seed)
  sniff [file]                guess delimiter, quote char, and whether row 1 is a header

EDIT
  dedupe [file]               --key col[,col,...]  (full row if no --key)  --keep first|last
  sort [file]                 --key col[,-col]     multi-key  --numeric  --natural  --locale
  filter [file]               --where "expr"       SQL-WHERE-ish on columns: age>30 AND city='NYC'
  cols [file]                 --keep a,b           --drop x,y       --order b,a,c
                              --rename old:new,o2:n2
  transpose [file]            swap rows and columns
  merge file1.csv file2.csv   concatenate vertically; header from first file
  split [file]                --rows N | --size 10MB | --by COLUMN     writes to ./<prefix>-N.csv
  diff a.csv b.csv            --key id    row-level diff (added/removed/changed)

CONVERT  (defaults to JSONL on the JSONL side)
  from <fmt> [file]           json | jsonl | tsv | md | html | xml | yaml
  to   <fmt> [file]           json | jsonl | tsv | md | html | sql | xml | yaml

GLOBAL FLAGS
  -d, --delim CHAR            input delimiter (auto-detected if not set)
  --out-delim CHAR            output delimiter (defaults to input)
  --no-header                 treat the first row as data, not a header
  --quote CHAR                quote character (default ")
  --bom                       emit a UTF-8 BOM on output
  --progress                  records/sec on stderr (TTY only)
  -h, --help                  show this help (or 'csvkit <cmd> --help' for a command)
  --version                   show version

EXAMPLES
  csvkit stats huge.csv
  csvkit dedupe --key email contacts.csv > unique.csv
  csvkit filter --where "amount > 100" txns.csv | csvkit sort --key date -
  csvkit diff --key id v1.csv v2.csv
  csvkit to json data.csv --pretty > data.json
  cat raw.csv | csvkit fix | csvkit dedupe --key id | csvkit to jsonl > clean.jsonl
`;

export async function main(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(pkg.version + "\n");
    return;
  }
  const cmd = argv[0];
  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write("csvkit: unknown command '" + cmd + "'\n\nRun 'csvkit --help' for usage.\n");
    process.exit(3);
  }
  const mod = await loader();
  await mod.run(argv.slice(1), cmd);
}

/* ---------- shared arg-parsing helpers used by command modules ---------- */

export function parseArgs(argv, spec) {
  /* spec: { flags: { '--key': 'string'|'number'|'bool', '-k': '--key' (alias) }, allowPositional: true } */
  const out = { _: [], flags: {} };
  const aliases = {};
  const types = {};
  for (const [k, v] of Object.entries(spec.flags || {})) {
    if (typeof v === "string" && (v.startsWith("--") || v.startsWith("-"))) aliases[k] = v;
    else types[k] = v;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out.flags["--help"] = true; continue; }
    const canonical = aliases[a] || a;
    if (types[canonical] !== undefined) {
      if (types[canonical] === "bool") out.flags[canonical] = true;
      else {
        const next = argv[++i];
        if (next === undefined) throw new Error("flag " + canonical + " expects a value");
        out.flags[canonical] = types[canonical] === "number" ? Number(next) : next;
      }
    } else if (a.startsWith("--")) {
      /* unknown long flag treated as bool true */
      out.flags[a] = true;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      out.flags[a] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Resolve a delimiter flag value, expanding "\t" and "\\t" to a real tab. */
export function resolveDelim(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback || null;
  if (v === "\\t" || v === "tab" || v === "TAB") return "\t";
  return v;
}
