// Operand expression evaluator, shared by the assembler driver and by both CPU
// encoders. Kept in its own module so core/assembler.js and core/cpu80xx.js can
// each depend on it without importing each other (no cycles).
'use strict';

// ---- Number literals -------------------------------------------------------
// Accepts: 25 / 25D (decimal), 19H / 0x1F (hex), 1010B (binary), 17O / 17Q (octal),
// 'A' or "AB" (character - up to two chars, big-endian). Returns null if `tok`
// is not a recognisable number literal (so the expression parser can treat it
// as a symbol instead).
export function parseNumLit(tok) {
  tok = tok.trim();
  const mc = tok.match(/^'(.*)'$/) || tok.match(/^"(.*)"$/);
  if (mc) {
    const s = mc[1];
    if (s.length === 0) return 0;
    let v = 0;
    for (let i = 0; i < s.length && i < 2; i++) v = (v << 8) | (s.charCodeAt(i) & 0xFF);
    return v >>> 0;
  }
  if (/^0X[0-9A-F]+$/i.test(tok)) return parseInt(tok.slice(2), 16);
  if (/^[0-9][0-9A-F]*H$/i.test(tok)) return parseInt(tok.slice(0, -1), 16);
  if (/^[01]+B$/i.test(tok)) return parseInt(tok.slice(0, -1), 2);
  if (/^[0-7]+[OQ]$/i.test(tok)) return parseInt(tok.slice(0, -1), 8);
  if (/^[0-9]+D$/i.test(tok)) return parseInt(tok.slice(0, -1), 10);
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  return null;
}

// Back-compat helper: strict "must be a number" parse.
export function parseNumber(tok) {
  const v = parseNumLit(tok);
  if (v === null) throw new Error(`Invalid number literal '${tok}' (hex needs a leading digit and an H suffix, e.g. 0FFH)`);
  return v;
}

// ---- Expression evaluator -------------------------------------------------
// Recursive-descent evaluator for operand expressions. Supports labels, the
// current-address symbol `$`, character literals, parentheses, the operators
// | ^ & << >> + - * / % (and their word forms OR XOR AND SHL SHR MOD), unary
// + - ~ NOT, and the MASM-style HIGH / LOW / OFFSET / SEG prefixes.
// ctx = { pass, symtab:Map, address:Number }
export function evalExpr(src, ctx) {
  const s = String(src);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const done = () => { ws(); return i >= s.length; };
  const eat = (re) => { ws(); const m = s.slice(i).match(re); if (m) { i += m[0].length; return m[0]; } return null; };

  function primary() {
    ws();
    if (s[i] === '(') { i++; const v = bitOr(); ws(); if (s[i] !== ')') throw new Error(`Missing ')' in expression '${s}'`); i++; return v; }
    if (s[i] === '$') { i++; return ctx.address & 0xFFFF; }
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i]; let j = i + 1, str = '';
      while (j < s.length && s[j] !== q) { str += s[j]; j++; }
      if (s[j] !== q) throw new Error(`Unterminated character literal in '${s}'`);
      i = j + 1;
      let v = 0; for (let k = 0; k < str.length && k < 2; k++) v = (v << 8) | (str.charCodeAt(k) & 0xFF);
      return v;
    }
    const word = eat(/^[0-9A-Za-z_.]+/);
    if (word === null) throw new Error(`Unexpected '${s[i] || 'end of input'}' in expression '${s}'`);
    const up = word.toUpperCase();
    // MASM-ish prefix operators - only treated as operators when something follows,
    // so a label that happens to be spelled "OFFSET"/"LOW"/... still resolves.
    if ((up === 'OFFSET' || up === 'SEG' || up === 'HIGH' || up === 'LOW' || up === 'NOT') && !done() && !/^[),]/.test(s.slice(i).trim())) {
      if (up === 'SEG') { primary(); return 0; }
      if (up === 'HIGH') return (primary() >> 8) & 0xFF;
      if (up === 'LOW') return primary() & 0xFF;
      if (up === 'NOT') return (~primary()) & 0xFFFF;
      return primary(); // OFFSET
    }
    if (/^[0-9]/.test(word)) {
      const n = parseNumLit(word);
      if (n === null) throw new Error(`Invalid number literal '${word}' (hex needs a leading digit and an H suffix, e.g. 0FFH)`);
      return n;
    }
    if (ctx.symtab.has(up)) return ctx.symtab.get(up) & 0xFFFF;
    if (ctx.pass === 1) return 0;
    throw new Error(`Undefined label '${word}'`);
  }
  function unary() {
    ws();
    if (s[i] === '+') { i++; return unary(); }
    if (s[i] === '-') { i++; return (-unary()) | 0; }
    if (s[i] === '~') { i++; return (~unary()) | 0; }
    return primary();
  }
  function mul() {
    let v = unary();
    for (;;) { const op = eat(/^(\*|\/|%|MOD(?![A-Za-z0-9_]))/i); if (!op) break; const r = unary();
      if (op === '*') v = Math.trunc(v * r);
      else if (op === '/') v = r === 0 ? 0 : Math.trunc(v / r);
      else v = r === 0 ? 0 : Math.trunc(v % r);
    }
    return v;
  }
  function add() {
    let v = mul();
    for (;;) { ws(); const c = s[i];
      if (c === '+') { i++; v += mul(); }
      else if (c === '-') { i++; v -= mul(); }
      else break;
    }
    return v;
  }
  function shift() {
    let v = add();
    for (;;) { const op = eat(/^(<<|>>|SHL(?![A-Za-z0-9_])|SHR(?![A-Za-z0-9_]))/i); if (!op) break; const r = add();
      v = (op === '<<' || /SHL/i.test(op)) ? (v << r) : (v >> r);
    }
    return v;
  }
  function bitAnd() { let v = shift(); for (;;) { if (!eat(/^(&|AND(?![A-Za-z0-9_]))/i)) break; v &= shift(); } return v; }
  function bitXor() { let v = bitAnd(); for (;;) { if (!eat(/^(\^|XOR(?![A-Za-z0-9_]))/i)) break; v ^= bitAnd(); } return v; }
  function bitOr() { let v = bitXor(); for (;;) { if (!eat(/^(\||OR(?![A-Za-z0-9_]))/i)) break; v |= bitXor(); } return v; }

  const result = bitOr();
  if (!done()) throw new Error(`Unexpected '${s.slice(i).trim()}' in expression '${s}'`);
  return result | 0;
}

// Resolves a numeric operand expression to a 16-bit value.
export function resolveOperand(tok, ctx) {
  return evalExpr(tok, ctx) & 0xFFFF;
}
