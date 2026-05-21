import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "csvkit");
const FX = join(__dirname, "fixtures");

function runCli(args, stdin) {
  return new Promise((resolve) => {
    const p = spawn("node", [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { err += b; });
    p.on("close", (code) => resolve({ code, out, err }));
    if (stdin !== undefined) p.stdin.write(stdin);
    p.stdin.end();
  });
}

test("--version prints semver", async () => {
  const r = await runCli(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^\d+\.\d+\.\d+/);
});

test("--help lists commands", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /validate/);
  assert.match(r.out, /dedupe/);
  assert.match(r.out, /diff/);
});

test("unknown command exits 3", async () => {
  const r = await runCli(["wat"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /unknown command/);
});

test("count returns data rows (excludes header)", async () => {
  const r = await runCli(["count", join(FX, "basic.csv")]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "3");
});

test("count --no-header includes all rows", async () => {
  const r = await runCli(["count", "--no-header", join(FX, "basic.csv")]);
  assert.equal(r.out.trim(), "4");
});

test("count --json emits structured", async () => {
  const r = await runCli(["count", "--json", join(FX, "basic.csv")]);
  const s = JSON.parse(r.out);
  assert.equal(s.rows, 3);
  assert.equal(s.header, true);
});

test("head -n 2 keeps header + first 2 data rows", async () => {
  const r = await runCli(["head", "-n", "2", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "id,name,age,city");
});

test("tail -n 2 keeps header + last 2 data rows", async () => {
  const r = await runCli(["tail", "-n", "2", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2], /Grace/);
});

test("sample --seed is deterministic", async () => {
  const a = await runCli(["sample", "-n", "2", "--seed", "42", join(FX, "basic.csv")]);
  const b = await runCli(["sample", "-n", "2", "--seed", "42", join(FX, "basic.csv")]);
  assert.equal(a.out, b.out);
});

test("stats lists columns and types", async () => {
  const r = await runCli(["stats", join(FX, "basic.csv")]);
  assert.equal(r.code, 0);
  assert.match(r.out, /rows:\s+3/);
  assert.match(r.out, /id\s+integer/);
  assert.match(r.out, /name\s+string/);
});

test("stats --json works", async () => {
  const r = await runCli(["stats", "--json", join(FX, "basic.csv")]);
  const s = JSON.parse(r.out);
  assert.equal(s.rows, 3);
  assert.ok(s.columns.find((c) => c.name === "age" && c.numeric === true));
});

test("validate clean file passes", async () => {
  const r = await runCli(["validate", "--quiet", join(FX, "basic.csv")]);
  assert.equal(r.code, 0);
});

test("validate --required catches blanks", async () => {
  const stdin = "id,name\n1,Ada\n2,\n";
  const r = await runCli(["validate", "--quiet", "--required", "name"], stdin);
  assert.equal(r.code, 1);
  assert.match(r.err, /required column 'name' is empty/);
});

test("validate --unique catches duplicates", async () => {
  const r = await runCli(["validate", "--quiet", "--unique", "id", join(FX, "dupes.csv")]);
  assert.equal(r.code, 1);
  assert.match(r.err, /duplicate '1'/);
});

test("validate --type checks numeric column", async () => {
  const stdin = "id,age\n1,thirty\n";
  const r = await runCli(["validate", "--quiet", "--type", "age:integer"], stdin);
  assert.equal(r.code, 1);
  assert.match(r.err, /expected integer/);
});

test("fix pads ragged rows", async () => {
  const r = await runCli(["fix", join(FX, "dirty.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "id,name,note");
  /* row with missing 'note' becomes id,name, */
  assert.match(lines[2], /^2,Linus,/);
});

test("fix normalises smart quotes", async () => {
  const r = await runCli(["fix", join(FX, "dirty.csv")]);
  /* smart quotes get rewritten to ASCII " — and once that happens the parser
     treats them as CSV field-quoting and unwraps the value. */
  assert.ok(!/[“”‘’]/.test(r.out), "smart quotes should be gone from output");
  assert.match(r.out, /^1,Ada,hello$/m);
});

test("dedupe full-row drops exact duplicates", async () => {
  const stdin = "a,b\n1,x\n1,x\n2,y\n";
  const r = await runCli(["dedupe"], stdin);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3); /* header + 2 rows */
});

test("dedupe --key by single column", async () => {
  const r = await runCli(["dedupe", "--key", "id", join(FX, "dupes.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 4); /* header + 3 unique ids */
});

test("dedupe --key --case-insensitive matches Linus/LINUS", async () => {
  const r = await runCli(["dedupe", "--key", "email", "--case-insensitive", join(FX, "dupes.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 4); /* header + 3 unique emails */
});

test("sort by single column ascending", async () => {
  const r = await runCli(["sort", "--key", "name", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.match(lines[1], /Ada/);
  assert.match(lines[2], /Grace/);
  assert.match(lines[3], /Linus/);
});

test("sort --numeric --key -age sorts descending by age", async () => {
  const r = await runCli(["sort", "--numeric", "--key", "-age", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.match(lines[1], /Grace/); /* 85 */
  assert.match(lines[2], /Linus/); /* 55 */
  assert.match(lines[3], /Ada/);   /* 36 */
});

test("filter --where with comparison", async () => {
  const r = await runCli(["filter", "--where", "age > 50", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3); /* header + 2 rows (Linus, Grace) */
});

test("filter --where LIKE pattern", async () => {
  const r = await runCli(["filter", "--where", "name LIKE 'A%'", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 2); /* header + Ada */
});

test("filter --where IN list", async () => {
  const r = await runCli(["filter", "--where", "city IN ('London','Helsinki')", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3);
});

test("cols --keep restricts columns", async () => {
  const r = await runCli(["cols", "--keep", "id,name", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "id,name");
  assert.equal(lines[1], "1,Ada");
});

test("cols --drop removes columns", async () => {
  const r = await runCli(["cols", "--drop", "age", join(FX, "basic.csv")]);
  assert.equal(r.out.split("\n")[0], "id,name,city");
});

test("cols --rename renames headers", async () => {
  const r = await runCli(["cols", "--rename", "name:full_name", join(FX, "basic.csv")]);
  assert.equal(r.out.split("\n")[0], "id,full_name,age,city");
});

test("cols --list prints columns one per line", async () => {
  const r = await runCli(["cols", "--list", join(FX, "basic.csv")]);
  assert.equal(r.out.trim(), "id\nname\nage\ncity");
});

test("transpose swaps rows and columns", async () => {
  const r = await runCli(["transpose"], "a,b,c\n1,2,3\n4,5,6\n");
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "a,1,4");
  assert.equal(lines[2], "c,3,6");
});

test("merge concatenates two files with shared header", async () => {
  const r = await runCli(["merge", join(FX, "v1.csv"), join(FX, "v2.csv")]);
  const lines = r.out.trim().split("\n");
  /* header + 3 from v1 + 3 from v2 = 7 */
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "id,name,city");
});

test("diff finds added/removed/changed by key", async () => {
  const r = await runCli(["diff", "--key", "id", join(FX, "v1.csv"), join(FX, "v2.csv")]);
  /* v1 has 1,2,3; v2 has 1,2,4 => added 4, removed 3, changed 2 (Helsinki->Stockholm) */
  assert.match(r.out, /added 1/);
  assert.match(r.out, /removed 1/);
  assert.match(r.out, /changed 1/);
  assert.equal(r.code, 1);
});

test("diff --csv emits a unified CSV with __op", async () => {
  const r = await runCli(["diff", "--csv", "--key", "id", join(FX, "v1.csv"), join(FX, "v2.csv")]);
  assert.match(r.out, /__op,id,name,city/);
  assert.match(r.out, /added/);
  assert.match(r.out, /removed/);
  assert.match(r.out, /changed/);
});

test("sniff guesses comma", async () => {
  const r = await runCli(["sniff", join(FX, "basic.csv")]);
  assert.equal(r.code, 0);
  assert.match(r.out, /delim:\s+,/);
  assert.match(r.out, /header:\s+yes/);
});

test("sniff --json comma", async () => {
  const r = await runCli(["sniff", "--json", join(FX, "basic.csv")]);
  const s = JSON.parse(r.out);
  assert.equal(s.delim, ",");
  assert.equal(s.hasHeader, true);
});

test("to json emits an array", async () => {
  const r = await runCli(["to", "json", join(FX, "basic.csv")]);
  const arr = JSON.parse(r.out);
  assert.equal(arr.length, 3);
  assert.equal(arr[0].id, 1);
  assert.equal(arr[0].name, "Ada");
});

test("to jsonl emits one record per line", async () => {
  const r = await runCli(["to", "jsonl", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[1].name, "Linus");
});

test("to tsv replaces delim", async () => {
  const r = await runCli(["to", "tsv", join(FX, "basic.csv")]);
  assert.match(r.out, /id\tname\tage\tcity/);
});

test("to md emits a github table", async () => {
  const r = await runCli(["to", "md", join(FX, "basic.csv")]);
  const lines = r.out.trim().split("\n");
  assert.match(lines[0], /^\| id \| name/);
  assert.match(lines[1], /^\|---/);
});

test("to html emits a table", async () => {
  const r = await runCli(["to", "html", join(FX, "basic.csv")]);
  assert.match(r.out, /<table>/);
  assert.match(r.out, /<th>id<\/th>/);
});

test("to sql emits INSERTs with --table", async () => {
  const r = await runCli(["to", "sql", "--table", "people", join(FX, "basic.csv")]);
  assert.match(r.out, /INSERT INTO `people`/);
  assert.match(r.out, /'Ada'/);
});

test("to sql --create emits CREATE TABLE", async () => {
  const r = await runCli(["to", "sql", "--table", "people", "--create", "--dialect", "postgres", join(FX, "basic.csv")]);
  assert.match(r.out, /CREATE TABLE "people"/);
  assert.match(r.out, /"age" INTEGER/);
});

test("to xml emits a row per record", async () => {
  const r = await runCli(["to", "xml", join(FX, "basic.csv")]);
  assert.match(r.out, /<rows>/);
  assert.match(r.out, /<name>Ada<\/name>/);
});

test("to yaml emits a list", async () => {
  const r = await runCli(["to", "yaml", join(FX, "basic.csv")]);
  assert.match(r.out, /- id: 1/);
  assert.match(r.out, /name: Ada/);
});

test("from jsonl flattens nested objects", async () => {
  const r = await runCli(["from", "jsonl", join(FX, "nested.jsonl")]);
  const lines = r.out.trim().split("\n");
  assert.match(lines[0], /user\.name/);
  assert.match(lines[1], /Ada,ada@example.com,true/);
});

test("from json reads an array", async () => {
  const stdin = '[{"a":1,"b":"x"},{"a":2,"b":"y"}]';
  const r = await runCli(["from", "json"], stdin);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "a,b");
  assert.equal(lines[1], "1,x");
});

test("from md parses a markdown table", async () => {
  const stdin = "| a | b |\n|---|---|\n| 1 | x |\n| 2 | y |\n";
  const r = await runCli(["from", "md"], stdin);
  assert.match(r.out, /a,b\n1,x\n2,y/);
});

test("from tsv converts to CSV", async () => {
  const stdin = "a\tb\n1\tx\n2\ty\n";
  const r = await runCli(["from", "tsv"], stdin);
  assert.match(r.out, /a,b\n1,x\n2,y/);
});

test("pipeline: from jsonl | to json round-trips", async () => {
  const csv = await runCli(["from", "jsonl", join(FX, "nested.jsonl")]);
  const json = await runCli(["to", "json"], csv.out);
  const arr = JSON.parse(json.out);
  assert.equal(arr.length, 3);
  /* nested keys came back flat as dotted strings */
  assert.equal(arr[0]["user.name"], "Ada");
});

test("filter -> sort -> count pipeline", async () => {
  const f = await runCli(["filter", "--where", "age >= 50", join(FX, "basic.csv")]);
  const s = await runCli(["sort", "--numeric", "--key", "age"], f.out);
  const c = await runCli(["count"], s.out);
  assert.equal(c.out.trim(), "2");
});

test("split --rows N writes multiple files", async () => {
  /* copy fixture to tmp so split writes there */
  const src = readFileSync(join(FX, "basic.csv"));
  const tmp = join(tmpdir(), "csvkit-split-" + process.pid + ".csv");
  const fs = await import("node:fs/promises");
  await fs.writeFile(tmp, src);
  try {
    const r = await runCli(["split", "--rows", "2", tmp]);
    assert.equal(r.code ?? 0, 0);
    const base = tmp.replace(/\.csv$/, "");
    assert.ok(existsSync(base + "-001.csv"));
    assert.ok(existsSync(base + "-002.csv"));
    const part1 = readFileSync(base + "-001.csv", "utf8").trim().split("\n");
    assert.equal(part1.length, 3); /* header + 2 rows */
    /* cleanup */
    for (const f of readdirSync(tmpdir()).filter((n) => n.startsWith("csvkit-split-" + process.pid))) {
      try { unlinkSync(join(tmpdir(), f)); } catch (_e) {}
    }
  } finally {
    try { unlinkSync(tmp); } catch (_e) {}
  }
});

test("format --beautify pads columns", async () => {
  const r = await runCli(["format", "--beautify"], "id,name\n1,Ada\n200,Linus\n");
  /* each column padded to widest value */
  const lines = r.out.trim().split("\n");
  assert.match(lines[0], /id /);
  assert.match(lines[1], /1  /); /* "1" padded to width 3 */
});
