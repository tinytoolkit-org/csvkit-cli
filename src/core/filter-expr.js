/**
 * Tiny SQL-WHERE-ish expression evaluator.
 *
 * Supported:
 *   - column references: bare identifier (matches header name), backticks for spaced names
 *   - literals: numbers, single-quoted strings, true/false/null
 *   - comparison: = == != <> < <= > >=  (numeric if both sides numeric, else string)
 *   - LIKE 'pattern'   (% wildcard, _ single char)  IN (a,b,c)
 *   - logical: AND OR NOT, parentheses
 *
 * Not supported: arithmetic, functions, subqueries, BETWEEN.
 */

export function compileExpression(expr, header) {
  const tokens = tokenize(expr);
  let i = 0;

  function peek() { return tokens[i]; }
  function take(t) {
    if (!tokens[i]) throw new Error("unexpected end of expression");
    if (t && tokens[i].type !== t) throw new Error("expected " + t + " got " + tokens[i].type + " (" + tokens[i].value + ")");
    return tokens[i++];
  }
  function takeKw(kw) {
    const t = tokens[i];
    if (!t || t.type !== "kw" || t.value.toUpperCase() !== kw.toUpperCase()) return false;
    i++; return true;
  }

  function parseOr() {
    let left = parseAnd();
    while (takeKw("OR")) { const right = parseAnd(); left = { op: "or", l: left, r: right }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (takeKw("AND")) { const right = parseNot(); left = { op: "and", l: left, r: right }; }
    return left;
  }
  function parseNot() {
    if (takeKw("NOT")) return { op: "not", x: parseNot() };
    return parseCmp();
  }
  function parseCmp() {
    if (peek() && peek().type === "lparen") {
      take("lparen");
      const inner = parseOr();
      take("rparen");
      return inner;
    }
    const left = parseValue();
    const t = peek();
    if (!t) return { op: "truthy", x: left };
    if (t.type === "op") {
      take("op");
      const right = parseValue();
      return { op: t.value === "==" ? "=" : (t.value === "<>" ? "!=" : t.value), l: left, r: right };
    }
    if (t.type === "kw") {
      const kw = t.value.toUpperCase();
      if (kw === "LIKE") { i++; const right = parseValue(); return { op: "like", l: left, r: right }; }
      if (kw === "NOT" && tokens[i + 1] && tokens[i + 1].type === "kw" && tokens[i + 1].value.toUpperCase() === "LIKE") {
        i += 2; const right = parseValue(); return { op: "not", x: { op: "like", l: left, r: right } };
      }
      if (kw === "IN") {
        i++; take("lparen");
        const list = [];
        while (peek() && peek().type !== "rparen") {
          list.push(parseValue());
          if (peek() && peek().type === "comma") take("comma");
        }
        take("rparen");
        return { op: "in", l: left, r: list };
      }
      if (kw === "IS") {
        i++;
        if (takeKw("NOT")) { takeKw("NULL"); return { op: "not-null", x: left }; }
        takeKw("NULL");
        return { op: "is-null", x: left };
      }
    }
    return { op: "truthy", x: left };
  }
  function parseValue() {
    const t = take();
    if (t.type === "num") return { kind: "num", value: t.value };
    if (t.type === "str") return { kind: "str", value: t.value };
    if (t.type === "kw") {
      const v = t.value.toUpperCase();
      if (v === "TRUE") return { kind: "bool", value: true };
      if (v === "FALSE") return { kind: "bool", value: false };
      if (v === "NULL") return { kind: "null" };
      return { kind: "col", name: t.value };
    }
    if (t.type === "ident") return { kind: "col", name: t.value };
    throw new Error("unexpected token " + t.type);
  }

  const ast = parseOr();
  if (i < tokens.length) throw new Error("trailing tokens at " + tokens[i].value);

  const colIndex = (name) => header.indexOf(name);

  const evalNode = (node, row) => {
    switch (node.op || node.kind) {
      case "num": return node.value;
      case "str": return node.value;
      case "bool": return node.value;
      case "null": return null;
      case "col": {
        const idx = colIndex(node.name);
        if (idx < 0) return undefined;
        return row[idx];
      }
      case "=":  return eq(evalNode(node.l, row), evalNode(node.r, row));
      case "!=": return !eq(evalNode(node.l, row), evalNode(node.r, row));
      case "<":  return cmp(evalNode(node.l, row), evalNode(node.r, row)) < 0;
      case "<=": return cmp(evalNode(node.l, row), evalNode(node.r, row)) <= 0;
      case ">":  return cmp(evalNode(node.l, row), evalNode(node.r, row)) > 0;
      case ">=": return cmp(evalNode(node.l, row), evalNode(node.r, row)) >= 0;
      case "and": return !!evalNode(node.l, row) && !!evalNode(node.r, row);
      case "or":  return !!evalNode(node.l, row) || !!evalNode(node.r, row);
      case "not": return !evalNode(node.x, row);
      case "truthy": {
        const v = evalNode(node.x, row);
        if (v === "" || v == null) return false;
        if (v === "false" || v === "FALSE" || v === 0 || v === "0") return false;
        return true;
      }
      case "like": {
        const v = String(evalNode(node.l, row) ?? "");
        const pat = String(evalNode(node.r, row) ?? "");
        return likeToRegex(pat).test(v);
      }
      case "in": {
        const v = evalNode(node.l, row);
        for (const r of node.r) if (eq(v, evalNode(r, row))) return true;
        return false;
      }
      case "is-null": {
        const v = evalNode(node.x, row);
        return v === "" || v == null;
      }
      case "not-null": {
        const v = evalNode(node.x, row);
        return v !== "" && v != null;
      }
    }
    throw new Error("unknown node " + JSON.stringify(node));
  };

  return (row) => !!evalNode(ast, row);
}

function eq(a, b) {
  if (a == null && b == null) return true;
  const an = numIf(a), bn = numIf(b);
  if (an !== null && bn !== null) return an === bn;
  return String(a == null ? "" : a) === String(b == null ? "" : b);
}
function cmp(a, b) {
  const an = numIf(a), bn = numIf(b);
  if (an !== null && bn !== null) return an - bn;
  const sa = String(a == null ? "" : a), sb = String(b == null ? "" : b);
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}
function numIf(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return null;
}
function likeToRegex(pat) {
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else if (/[.*+?^${}()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

function tokenize(s) {
  const out = [];
  let i = 0;
  const KW = new Set(["AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "TRUE", "FALSE"]);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { out.push({ type: "lparen", value: "(" }); i++; continue; }
    if (c === ")") { out.push({ type: "rparen", value: ")" }); i++; continue; }
    if (c === ",") { out.push({ type: "comma", value: "," }); i++; continue; }
    if (c === "'") {
      let v = ""; i++;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; continue; }
        v += s[i++];
      }
      i++;
      out.push({ type: "str", value: v });
      continue;
    }
    if (c === '"') {
      let v = ""; i++;
      while (i < s.length && s[i] !== '"') v += s[i++];
      i++;
      out.push({ type: "str", value: v });
      continue;
    }
    if (c === "`") {
      let v = ""; i++;
      while (i < s.length && s[i] !== "`") v += s[i++];
      i++;
      out.push({ type: "ident", value: v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(s[i + 1]))) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      out.push({ type: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    const opMatch = /^(==|!=|<>|<=|>=|=|<|>)/.exec(s.slice(i));
    if (opMatch) { out.push({ type: "op", value: opMatch[0] }); i += opMatch[0].length; continue; }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (idMatch) {
      const v = idMatch[0];
      if (KW.has(v.toUpperCase())) out.push({ type: "kw", value: v });
      else out.push({ type: "ident", value: v });
      i += v.length;
      continue;
    }
    throw new Error("unexpected char '" + c + "' at " + i + " in expression");
  }
  return out;
}
