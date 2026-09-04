// Module 1: Assembler & Instruction Decoder (front half).
// Architecture-agnostic tokenizer + multi-pass assembler driver. The actual mnemonic
// encoding (text -> bytes) is delegated to CPU8085.encode / CPU8086.encode, so this
// file never needs to know instruction-set details - only line syntax and layout.
'use strict';

import { evalExpr, resolveOperand, parseNumLit } from './expr.js';
import { CPU8085 } from './cpu8085.js';
import { CPU8086 } from './cpu8086.js';

// ---- Line parsing ------------------------------------------------------------
export function splitOperands(s) {
  const parts = []; let cur = ''; let depth = 0; let inQuote = null;
  for (const ch of s) {
    if (inQuote) { cur += ch; if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(op => (op.startsWith('"') || op.startsWith("'")) ? op : op.toUpperCase());
}

export function parseLine(rawLine) {
  let idx = -1;
  { // find a ';' that is not inside quotes
    let q = null;
    for (let k = 0; k < rawLine.length; k++) {
      const c = rawLine[k];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ';') { idx = k; break; }
    }
  }
  let line = (idx >= 0 ? rawLine.slice(0, idx) : rawLine).replace(/\t/g, ' ').trim();
  if (!line) return null;

  const mEqu = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(EQU|SET|=)\s+(.+)$/i);
  if (mEqu) return { label: mEqu[1], mnemonic: 'EQU', operands: [mEqu[3].trim().toUpperCase()] };

  let label = null;
  const mLabel = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
  if (mLabel) { label = mLabel[1]; line = mLabel[2].trim(); }
  if (!line) return { label, mnemonic: null, operands: [] };

  const mSplit = line.match(/^(\S+)\s*(.*)$/);
  let mnemonic = mSplit[1].toUpperCase();
  let rest = mSplit[2].trim();

  // "name DB ..." / "name DW ..." / "name DS ..." (storage with a leading name, no colon)
  if (/^(DB|DW|DD|DS|RESB|RESW)$/i.test(rest.split(/\s+/)[0] || '') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(mnemonic)) {
    const p = rest.split(/\s+/);
    label = mnemonic;
    mnemonic = p.shift().toUpperCase();
    rest = p.join(' ').trim();
  }

  const operands = rest ? splitOperands(rest) : [];
  return { label, mnemonic, operands };
}

// ---- Storage directives ----------------------------------------------------
// Expands "count DUP (value...)" once. Returns an array of operand strings.
function expandDup(operands) {
  const out = [];
  for (const op of operands) {
    const m = op.match(/^(.+?)\s+DUP\s*\((.*)\)$/i);
    if (m) {
      const count = parseNumLit(m[1].trim());
      const n = (count === null || count < 0) ? 0 : count;
      const inner = splitOperands(m[2]);
      for (let k = 0; k < n; k++) out.push(...inner);
    } else out.push(op);
  }
  return out;
}

function sizeOfDB(operands) {
  let n = 0;
  for (const op of expandDup(operands)) {
    const m = op.match(/^"([^"]*)"$/) || op.match(/^'([^']*)'$/);
    if (m) n += Math.max(m[1].length, 1);
    else n += 1;
  }
  return n;
}
function encodeDB(operands, ctx) {
  const bytes = [];
  for (const op of expandDup(operands)) {
    const m = op.match(/^"([^"]*)"$/) || op.match(/^'([^']*)'$/);
    if (m) { if (m[1].length === 0) bytes.push(0); else for (const ch of m[1]) bytes.push(ch.charCodeAt(0) & 0xFF); }
    else if (op === '?' ) bytes.push(0);
    else bytes.push(resolveOperand(op, ctx) & 0xFF);
  }
  return bytes;
}
function encodeDW(operands, ctx) {
  const bytes = [];
  for (const op of expandDup(operands)) {
    const v = (op === '?') ? 0 : resolveOperand(op, ctx) & 0xFFFF;
    bytes.push(v & 0xFF, (v >> 8) & 0xFF);
  }
  return bytes;
}

// ---- Assembler driver ----------------------------------------------------
// Assembles source text for the given architecture ('8085' | '8086').
// Returns { success, errors:[{lineNo,message}], listing:[...], symtab, memory,
//           minAddr, maxAddr, startAddress }
export function assemble(source, archName) {
  const mod = archName === '8086' ? CPU8086 : CPU8085;
  const lines = source.split(/\r\n|\r|\n/);
  const relax = mod.branchRelax || null;         // { promotable:Set, shortSize, longSize } or null
  const longBranches = new Set();                // line numbers assembled as a long (near) branch

  let sizing = null;
  for (let iter = 0; iter < 12; iter++) {
    sizing = runSizingPass(lines, mod, longBranches);
    if (!relax || sizing.errors.length) break;
    let changed = false;
    for (const b of sizing.branches) {
      if (longBranches.has(b.lineNo)) continue;
      let rel;
      try {
        const target = evalExpr(b.operand, { pass: 2, symtab: sizing.symtab, address: b.address });
        rel = target - ((b.address + relax.shortSize) & 0xFFFF);
        if (rel > 0x7FFF) rel -= 0x10000; else if (rel < -0x8000) rel += 0x10000;
      } catch (e) { continue; }
      if (rel < -128 || rel > 127) { longBranches.add(b.lineNo); changed = true; }
    }
    if (!changed) break;
  }

  const { parsedLines, symtab, startDirective } = sizing;

  const memory = new Uint8Array(0x10000);
  const listing = [];
  let minAddr = null, maxAddr = null;

  const pass1Errors = sizing.errors.slice();
  const errors = [];

  for (const entry of parsedLines) {
    try {
      if (entry.directive === 'EQU' || entry.directive === 'ORG' || entry.directive === 'END') { listing.push({ ...entry, bytes: [] }); continue; }
      let bytes;
      const ctx = { pass: 2, symtab, address: entry.address, lineNo: entry.lineNo, longBranches };
      if (entry.mnemonic === 'DB') bytes = encodeDB(entry.operands, ctx);
      else if (entry.mnemonic === 'DW') bytes = encodeDW(entry.operands, ctx);
      else if (entry.mnemonic === 'DS' || entry.mnemonic === 'RESB') bytes = new Array(Math.max(0, resolveOperand(entry.operands[0] || '0', ctx))).fill(0);
      else if (entry.mnemonic === 'RESW') bytes = new Array(Math.max(0, resolveOperand(entry.operands[0] || '0', ctx)) * 2).fill(0);
      else bytes = mod.encode(entry.mnemonic, entry.operands, ctx);
      for (let k = 0; k < bytes.length; k++) memory[(entry.address + k) & 0xFFFF] = bytes[k] & 0xFF;
      if (bytes.length > 0) {
        if (minAddr === null || entry.address < minAddr) minAddr = entry.address;
        if (maxAddr === null || entry.address + bytes.length - 1 > maxAddr) maxAddr = entry.address + bytes.length - 1;
      }
      listing.push({ ...entry, bytes });
    } catch (e) { errors.push({ lineNo: entry.lineNo, message: e.message }); }
  }

  // Merge: keep pass-1 errors that pass 2 did not also report for that line.
  const p2lines = new Set(errors.map(e => e.lineNo));
  for (const e of pass1Errors) if (!p2lines.has(e.lineNo)) errors.push(e);
  errors.sort((a, b) => a.lineNo - b.lineNo || a.message.localeCompare(b.message));

  let startAddress = (startDirective != null) ? startDirective : (minAddr || 0);
  for (const name of ['START', 'MAIN', 'BEGIN', '_START']) {
    if (symtab.has(name)) { startAddress = symtab.get(name); break; }
  }

  return { success: errors.length === 0, errors, listing, symtab, memory, minAddr, maxAddr, startAddress };
}

// One layout pass: assigns addresses, builds the symbol table, records the size
// of every line. `longBranches` (line numbers) forces those branches to the long
// form so their size matches what pass 2 will emit.
function runSizingPass(lines, mod, longBranches) {
  const symtab = new Map();
  const parsedLines = [];
  const errors = [];
  const branches = [];
  let LC = 0;
  let ended = false;
  let startDirective = null;
  const promotable = (mod.branchRelax && mod.branchRelax.promotable) || null;

  for (let i = 0; i < lines.length; i++) {
    if (ended) break;
    const lineNo = i + 1;
    let parsed;
    try { parsed = parseLine(lines[i]); } catch (e) { errors.push({ lineNo, message: e.message }); continue; }
    if (!parsed) continue;
    const { label, mnemonic, operands } = parsed;
    try {
      if (mnemonic === null) { if (label) symtab.set(label.toUpperCase(), LC); continue; }
      if (mnemonic === 'EQU') {
        if (!label) throw new Error('EQU requires a label, e.g. COUNT EQU 05H');
        const v = evalExpr(operands[0], { pass: 1, symtab, address: LC });
        symtab.set(label.toUpperCase(), v & 0xFFFF);
        parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size: 0, directive: 'EQU' });
        continue;
      }
      if (label) symtab.set(label.toUpperCase(), LC);
      if (mnemonic === 'ORG') {
        const v = evalExpr(operands[0], { pass: 1, symtab, address: LC }) & 0xFFFF;
        LC = v;
        if (startDirective === null) startDirective = v;
        parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size: 0, directive: 'ORG' });
        continue;
      }
      if (mnemonic === 'END') { ended = true; parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size: 0, directive: 'END' }); continue; }
      if (mnemonic === 'DB') { const size = sizeOfDB(operands); parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size, directive: 'DB' }); LC = (LC + size) & 0xFFFF; continue; }
      if (mnemonic === 'DW') { const size = expandDup(operands).length * 2; parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size, directive: 'DW' }); LC = (LC + size) & 0xFFFF; continue; }
      if (mnemonic === 'DS' || mnemonic === 'RESB' || mnemonic === 'RESW') {
        const unit = mnemonic === 'RESW' ? 2 : 1;
        const size = Math.max(0, evalExpr(operands[0] || '0', { pass: 1, symtab, address: LC })) * unit;
        parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size, directive: mnemonic });
        LC = (LC + size) & 0xFFFF; continue;
      }

      const ctx = { pass: 1, symtab, address: LC, lineNo, longBranches };
      const bytes = mod.encode(mnemonic, operands, ctx);
      if (promotable && promotable.has(mnemonic) && operands.length) branches.push({ lineNo, operand: operands[0], address: LC });
      parsedLines.push({ lineNo, label, mnemonic, operands, address: LC, size: bytes.length });
      LC = (LC + bytes.length) & 0xFFFF;
    } catch (e) { errors.push({ lineNo, message: e.message }); }
  }

  return { parsedLines, symtab, errors, branches, startDirective };
}
