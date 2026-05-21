/**
 * Per-row "fix" routines used by `csvkit fix`.
 *
 * The streaming parser already handles the common cases (BOM, CRLF). What this
 * module does is rescue rows that the parser couldn't handle by:
 *   - normalizing smart quotes to ASCII " before parsing,
 *   - padding ragged rows to header length,
 *   - truncating rows with too many fields,
 *   - reporting unterminated quoted fields.
 */

/** Replace common smart quotes / non-ASCII whitespace in a text chunk. */
export function preNormalize(text) {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, " ");
}

/** Pad short row to header length, truncate long. Returns { row, action }. */
export function reshapeRow(row, width) {
  if (row.length === width) return { row, action: "ok" };
  if (row.length < width) {
    const padded = row.slice();
    while (padded.length < width) padded.push("");
    return { row: padded, action: "padded" };
  }
  return { row: row.slice(0, width), action: "truncated" };
}
