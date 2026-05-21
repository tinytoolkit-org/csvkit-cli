# csvkit

> Validate, fix, convert, dedupe, sort, filter, diff and stat CSV files on the command line.
> Streaming-first — handles files larger than RAM. No upload, no telemetry.

**Browser version:** [csvkit.org](https://csvkit.org) · same toolkit, in a tab.

> **Note on the name.** A widely-used Python tool by the same name lives at <https://csvkit.readthedocs.io> — unrelated project, similar spirit, different language. This is the CLI companion to csvkit.org. Until npm publish, install via the GitHub URL below.

```bash
# install from github
npm install -g github:tinytoolkit-org/csvkit-cli

# or one-off
npx github:tinytoolkit-org/csvkit-cli --help
```

MIT licensed. No network calls. Requires Node 18+.

---

## Recipes — copy and paste

### Stats on a giant CSV

```bash
csvkit stats huge.csv
```

```
rows:    1,200,000
bytes:   4.2 GB
columns: 18

column                  type        nulls   unique    min          max
----------------------------------------------------------------------------------
id                      integer     0       1200000   1            1200000
email                   string      214     1198812
amount                  number      0       7821      0.01         99999.99
created_at              datetime    0       1200000   2024-01-01   2026-05-21
...
```

Streams the file. ~50 MB of RAM regardless of file size. `--json` for machine-readable output.

### Dedupe by a column

```bash
# by email
csvkit dedupe --key email contacts.csv > unique.csv

# composite key, case-insensitive
csvkit dedupe --key first_name,last_name --case-insensitive --trim people.csv
```

`--keep first` (default) streams with 40-byte sha1 digests per unique row. `--keep last` buffers in memory.

### Diff two CSVs by key

```bash
csvkit diff --key id v1.csv v2.csv
```

```
csvkit diff · added 12 · removed 3 · changed 47
+ 1042
+ 1043
- 871
~ 215
    email: "old@x.com" → "new@x.com"
    status: "pending" → "active"
```

Add `--csv` to get a unified diff CSV with an `__op` column you can pipe to other tools. `--added | --removed | --changed` filter to one kind.

### Filter rows with a WHERE clause

```bash
csvkit filter --where "amount > 100 AND status = 'paid'" txns.csv
csvkit filter --where "email LIKE '%@example.com'" users.csv
csvkit filter --where "city IN ('NYC','LA','Chicago')" addresses.csv
csvkit filter --where "phone IS NULL" contacts.csv
```

Supports `=  !=  <  <=  >  >=`, `LIKE` (with `%` and `_`), `IN (...)`, `IS NULL`, `IS NOT NULL`, `AND OR NOT`, parentheses. Numeric comparison when both sides parse as numbers, else string.

### Convert to anything (or from)

```bash
csvkit to json data.csv > data.json
csvkit to jsonl data.csv > data.jsonl
csvkit to md data.csv > data.md
csvkit to sql --table users --create --dialect postgres users.csv > seed.sql

csvkit from jsonl data.jsonl > data.csv
csvkit from json data.json > data.csv
csvkit from md notes.md > notes.csv
csvkit from html scraped.html > table.csv
```

JSON/JSONL/XML/YAML round-trip through nested keys with `--nest dot` (`user.email` → `{ user: { email: ... } }`).

### Sort by multiple keys

```bash
csvkit sort --key country,-revenue --numeric sales.csv
# ascending country, then descending revenue (numeric)
```

Modes: default lexical, `--numeric`, `--natural` (img2 before img10), `--locale`.

### Repair a broken CSV

```bash
csvkit fix broken.csv > clean.csv
```

Fixes:
- UTF-8 BOM, CRLF / lone CR line endings
- smart quotes ‘ ’ “ ” → straight ASCII
- ragged rows (pad short, truncate long)
- mixed quoting / non-breaking spaces

Use `--keep-ragged` to leave row widths alone.

### Validate before loading into a warehouse

```bash
csvkit validate \
  --required id,email \
  --unique id \
  --type "id:integer,age:integer,signup_at:datetime" \
  contacts.csv
```

Exit code 1 on any violation. Add `--json-errors` to pipe structured errors to another tool.

### Split a CSV into many

```bash
# fixed row count per output file
csvkit split --rows 100000 huge.csv
# → huge-001.csv, huge-002.csv, ...

# one file per distinct value in a column
csvkit split --by status orders.csv
# → orders-paid.csv, orders-pending.csv, orders-refunded.csv
```

### Headline pipeline

```bash
cat raw.csv \
  | csvkit fix \
  | csvkit dedupe --key id \
  | csvkit filter --where "active = true" \
  | csvkit to jsonl \
  > clean.jsonl
```

Cleaned, deduped, filtered, converted — all streaming.

---

## All commands

| Command                 | What it does |
|-------------------------|---|
| `count`                 | Fast row count (data rows by default; `--no-header` for raw) |
| `head` / `tail` / `sample` | Slice. `tail` seeks from end. `sample --seed N` for deterministic random |
| `stats`                 | Per-column: type, nulls, unique, min/max/avg |
| `validate`              | RFC 4180 + `--required`, `--unique`, `--type col:type`, `--max-rows` |
| `fix`                   | Smart quotes, BOM, line endings, ragged rows |
| `format`                | `--beautify` (align), `--quote all|none`, canonical re-emit |
| `dedupe`                | Full-row or `--key col`. `--case-insensitive`, `--trim`, `--keep first|last` |
| `sort`                  | Multi-key (`-col` for descending). `--numeric`, `--natural`, `--locale` |
| `filter`                | `--where "EXPR"` — `=`, `LIKE`, `IN`, `IS NULL`, `AND OR NOT` |
| `cols`                  | `--keep`, `--drop`, `--order`, `--rename old:new`, `--list` |
| `transpose`             | Swap rows and columns |
| `merge`                 | Concatenate multiple files; align by header name |
| `split`                 | `--rows N` or `--by COLUMN` — writes side-files |
| `diff`                  | Key-aware diff between two CSVs. `--csv` for unified output |
| `sniff`                 | Guess delimiter, quote char, whether row 1 is a header |
| `from <fmt>`            | `json | jsonl | tsv | md | html | xml | yaml` → CSV |
| `to <fmt>`              | CSV → `json | jsonl | tsv | md | html | sql | xml | yaml` |

Run `csvkit <command> --help` for full flags.

---

## Streaming & memory

Most commands stream row-by-row. Memory is bounded by the size of one row + the largest single quoted field.

| Command | Streams? |
|---|---|
| `count`, `stats`, `validate`, `fix`, `format`, `head`, `sample`, `filter`, `cols`, `dedupe --keep first`, `merge`, `split`, `from jsonl|tsv`, `to *` | ✅ |
| `tail` | ✅ — seeks from end on real files |
| `dedupe --keep last` | ⚠️ — buffers every unique row |
| `sort`, `transpose`, `diff`, `format --beautify`, `from json|md|html|xml|yaml` | ❌ — need the whole table |

Add `--progress` to `count`, `stats`, `validate` for live rows/sec on stderr.

---

## Delimiter, quoting, headers

Most commands auto-detect the delimiter when reading a real file (uses a small in-memory sniff over the first 64 KB). Override with `-d` / `--delim` (`tab` or `\t` for tab-separated). Output delimiter defaults to the input — change it with `--out-delim`.

`--no-header` treats the first row as data and synthesises column names `col1, col2, ...`.

`--quote CHAR` overrides the default `"` quote character.

```bash
csvkit count -d ";" euro.csv
csvkit to tsv data.csv               # delim → \t in output
csvkit cols --keep 1,3,5 noheader.csv --no-header
```

---

## Install

```bash
# from github (current)
npm install -g github:tinytoolkit-org/csvkit-cli

# from source
git clone https://github.com/tinytoolkit-org/csvkit-cli
cd csvkit-cli
npm test
npm link
```

Requires Node 18+. No dependencies — only `node:fs`, `node:crypto`, `node:readline`.

---

## Privacy

No telemetry. No network calls. No analytics. Files never leave your machine.

## Companion tools

Same look-and-feel, same streaming approach, different format:

- **[jsonlkit](https://github.com/tinytoolkit-org/jsonlkit-cli)** — JSONL on the command line. Pairs with [jsonlkit.com](https://jsonlkit.com). Validates 7 LLM fine-tune formats (OpenAI, Anthropic, Gemini, Llama, ShareGPT, Alpaca, Mistral). Combine with csvkit: `csvkit to jsonl data.csv | jsonlkit validate --openai`.

## Links

- Website: [csvkit.org](https://csvkit.org)
- Sample data: [github.com/tinytoolkit-org/csv-datasets](https://github.com/tinytoolkit-org/csv-datasets) — real-world CSV fixtures for parser tests
- Issues: [github.com/tinytoolkit-org/csvkit-cli/issues](https://github.com/tinytoolkit-org/csvkit-cli/issues)
- License: MIT
