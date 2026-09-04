// Module 1 (encoder half) + Module 2 (CPU execution engine) for the 8086.
//
// This is a real-opcode implementation of 8086 real-mode: the full ModRM
// addressing-mode set ([BX], [SI], [BX+SI+disp], direct [addr], ...), the
// arithmetic/logic/shift/rotate groups, string primitives with REP, stack and
// flag control, INT 21H/20H/10H services, and every conditional jump. Memory is
// one flat 64 KB space - segment registers exist and can be loaded/stored but do
// not translate addresses (there is no paging or protected mode here).
//
// The bytes the assembler emits are authentic 8086 machine code: real opcodes,
// real ModRM/SIB-free encoding, real immediates - so a listing can be checked
// against any 8086 reference.
'use strict';

import { hex2, hex4, parity8, CpuRuntimeError } from './common.js';
import { resolveOperand, evalExpr } from './expr.js';

export const CPU8086 = (function () {
  const REG16 = { AX: 0, CX: 1, DX: 2, BX: 3, SP: 4, BP: 5, SI: 6, DI: 7 };
  const REG16_NAMES = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
  const REG8 = { AL: 0, CL: 1, DL: 2, BL: 3, AH: 4, CH: 5, DH: 6, BH: 7 };
  const REG8_NAMES = ['AL', 'CL', 'DL', 'BL', 'AH', 'CH', 'DH', 'BH'];
  const REG8_PARENT = [['AX', 'lo'], ['CX', 'lo'], ['DX', 'lo'], ['BX', 'lo'], ['AX', 'hi'], ['CX', 'hi'], ['DX', 'hi'], ['BX', 'hi']];
  const SREG = { ES: 0, CS: 1, SS: 2, DS: 3 };
  const SREG_NAMES = ['ES', 'CS', 'SS', 'DS'];

  // reg-field order used by opcodes 80/81/83 and by the arithmetic opcode blocks
  const ARITH = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'];
  const ARITH_IDX = {}; ARITH.forEach((n, i) => ARITH_IDX[n] = i);
  // reg-field order for the D0-D3 / C0-C1 shift+rotate group
  const SHIFT_RF = { ROL: 0, ROR: 1, RCL: 2, RCR: 3, SHL: 4, SAL: 4, SHR: 5, SAR: 7 };
  const SHIFT_NAME = ['ROL', 'ROR', 'RCL', 'RCR', 'SHL', 'SHR', '?6', 'SAR'];
  // reg-field order for the F6/F7 group
  const GRP3_NAME = ['TEST', 'TEST', 'NOT', 'NEG', 'MUL', 'IMUL', 'DIV', 'IDIV'];

  const JCC_OPC = {
    JO: 0x70, JNO: 0x71, JB: 0x72, JC: 0x72, JNAE: 0x72, JNB: 0x73, JNC: 0x73, JAE: 0x73,
    JE: 0x74, JZ: 0x74, JNE: 0x75, JNZ: 0x75, JBE: 0x76, JNA: 0x76, JA: 0x77, JNBE: 0x77,
    JS: 0x78, JNS: 0x79, JP: 0x7A, JPE: 0x7A, JNP: 0x7B, JPO: 0x7B,
    JL: 0x7C, JNGE: 0x7C, JGE: 0x7D, JNL: 0x7D, JLE: 0x7E, JNG: 0x7E, JG: 0x7F, JNLE: 0x7F,
  };
  const JCC_CANON = {
    0x70: 'JO', 0x71: 'JNO', 0x72: 'JB', 0x73: 'JAE', 0x74: 'JE', 0x75: 'JNE', 0x76: 'JBE', 0x77: 'JA',
    0x78: 'JS', 0x79: 'JNS', 0x7A: 'JP', 0x7B: 'JNP', 0x7C: 'JL', 0x7D: 'JGE', 0x7E: 'JLE', 0x7F: 'JG',
  };
  const STRING_OPC = { MOVSB: [0xA4, 0], MOVSW: [0xA5, 1], CMPSB: [0xA6, 0], CMPSW: [0xA7, 1], STOSB: [0xAA, 0], STOSW: [0xAB, 1], LODSB: [0xAC, 0], LODSW: [0xAD, 1], SCASB: [0xAE, 0], SCASW: [0xAF, 1] };
  const FLAG_OPC = { CLC: 0xF8, STC: 0xF9, CLI: 0xFA, STI: 0xFB, CLD: 0xFC, STD: 0xFD, CMC: 0xF5 };
  const NO_OPERAND = {
    NOP: 0x90, HLT: 0xF4, RET: 0xC3, RETN: 0xC3, RETF: 0xCB, IRET: 0xCF, CBW: 0x98, CWD: 0x99,
    PUSHF: 0x9C, POPF: 0x9D, PUSHA: 0x60, POPA: 0x61, XLAT: 0xD7, XLATB: 0xD7, INTO: 0xCE, WAIT: 0x9B, LOCK: 0xF0, CLC: 0xF8, STC: 0xF9, CLI: 0xFA, STI: 0xFB, CLD: 0xFC, STD: 0xFD, CMC: 0xF5,
    DAA: 0x27, DAS: 0x2F, AAA: 0x37, AAS: 0x3F,
  };

  const REGISTER_NAMES = new Set([...Object.keys(REG16), ...Object.keys(REG8), ...Object.keys(SREG)]);
  const MNEMONICS = new Set([
    ...Object.keys(NO_OPERAND), 'MOV', 'XCHG', 'LEA', 'TEST', 'PUSH', 'POP', 'IN', 'OUT',
    ...ARITH, 'INC', 'DEC', 'NEG', 'NOT', 'MUL', 'IMUL', 'DIV', 'IDIV', 'AAM', 'AAD',
    ...Object.keys(SHIFT_RF), 'JMP', 'CALL', 'LOOP', 'LOOPE', 'LOOPZ', 'LOOPNE', 'LOOPNZ', 'JCXZ', 'INT', 'INT3',
    'REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', ...Object.keys(STRING_OPC), ...Object.keys(JCC_OPC),
  ]);
  const DIRECTIVES = new Set(['ORG', 'END', 'DB', 'DW', 'DD', 'DS', 'EQU', 'SET', 'RESB', 'RESW']);

  // ============================ ENCODER ============================

  function modrm(mod, reg, rm) { return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7); }

  // Splits the text inside [ ] into { base, index, dispExpr }.
  function parseMem(inner) {
    inner = inner.replace(/\]\s*\[/g, '+');
    const terms = [];
    let sign = 1, cur = '';
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k];
      if (ch === '+' || ch === '-') {
        if (cur.trim()) terms.push({ sign, tok: cur.trim() });
        sign = ch === '-' ? -1 : 1; cur = '';
      } else cur += ch;
    }
    if (cur.trim()) terms.push({ sign, tok: cur.trim() });

    let base = null, index = null;
    const disp = [];
    for (const t of terms) {
      const u = t.tok.toUpperCase().replace(/\*\s*1$/, '').trim();
      if (t.sign === 1 && (u === 'BX' || u === 'BP') && !base && !(u === index)) { base = u; continue; }
      if (t.sign === 1 && (u === 'SI' || u === 'DI') && !index) { index = u; continue; }
      if (u === 'BX' || u === 'BP' || u === 'SI' || u === 'DI') throw new Error(`Invalid 8086 memory operand [${inner}] - allowed base/index registers are BX, BP, SI, DI (each at most once, not negated)`);
      disp.push((t.sign === -1 ? '-(' : '+(') + t.tok + ')');
    }
    let dispExpr = disp.join('').replace(/^\+/, '');
    return { base, index, dispExpr: dispExpr || null };
  }

  // Classifies one operand token.
  function classify(tok) {
    let t = String(tok).trim();
    let size = null, seg = null, m;
    if ((m = t.match(/^(BYTE|WORD|DWORD)\s+PTR\s+(.+)$/i))) { size = /^B/i.test(m[1]) ? 1 : 2; t = m[2].trim(); }
    else if ((m = t.match(/^(BYTE|WORD|DWORD)\s+(\[.+\])$/i))) { size = /^B/i.test(m[1]) ? 1 : 2; t = m[2].trim(); }
    if ((m = t.match(/^(CS|DS|ES|SS)\s*:\s*(.+)$/i)) && /\[/.test(m[2])) { seg = m[1].toUpperCase(); t = m[2].trim(); }
    const up = t.toUpperCase();
    if (up in REG16) return { kind: 'r16', code: REG16[up], text: up };
    if (up in REG8) return { kind: 'r8', code: REG8[up], text: up };
    if (up in SREG) return { kind: 'sreg', code: SREG[up], text: up };
    // memory: [expr] | disp[expr] | [expr][expr] | disp[bx][si] ...  (bracket text has no nested brackets)
    if (t.includes('[') && /^[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)+$/.test(t)) {
      const inners = [...t.matchAll(/\[([^\[\]]*)\]/g)].map(x => x[1].trim()).filter(Boolean);
      const lead = t.replace(/\[[^\[\]]*\]/g, ' ').replace(/\s+/g, '').trim();
      let inner = inners.join('+');
      if (lead) inner = lead + '+' + inner;
      if (inner) return { kind: 'mem', mem: parseMem(inner), size, seg, text: t };
    }
    return { kind: 'imm', expr: t, text: t };
  }

  const isReg = o => o.kind === 'r16' || o.kind === 'r8';
  const regW = o => (o.kind === 'r16' ? 1 : 0);

  // Effective-address ModRM byte(s) for a memory operand + a given reg field.
  function emitMem(regField, mem, ctx) {
    const { base, index, dispExpr } = mem;
    const rmCode = eaCode(base, index);
    if (!base && !index) {                 // direct [addr]
      const v = dispExpr ? resolveOperand(dispExpr, ctx) : 0;
      return [modrm(0, regField, 6), v & 0xFF, (v >> 8) & 0xFF];
    }
    const symbolic = dispExpr && /[A-Za-z_$]/.test(dispExpr);
    if (!dispExpr) {
      if (base === 'BP' && !index) return [modrm(1, regField, rmCode), 0];
      return [modrm(0, regField, rmCode)];
    }
    if (symbolic) {
      const v = resolveOperand(dispExpr, ctx) & 0xFFFF;
      return [modrm(2, regField, rmCode), v & 0xFF, (v >> 8) & 0xFF];
    }
    let v = evalExpr(dispExpr, ctx) | 0;
    if (v === 0 && !(base === 'BP' && !index)) return [modrm(0, regField, rmCode)];
    if (v >= -128 && v <= 127) return [modrm(1, regField, rmCode), v & 0xFF];
    return [modrm(2, regField, rmCode), v & 0xFF, (v >> 8) & 0xFF];
  }
  function eaCode(base, index) {
    if (base === 'BX' && index === 'SI') return 0;
    if (base === 'BX' && index === 'DI') return 1;
    if (base === 'BP' && index === 'SI') return 2;
    if (base === 'BP' && index === 'DI') return 3;
    if (!base && index === 'SI') return 4;
    if (!base && index === 'DI') return 5;
    if (base === 'BP' && !index) return 6;
    if (base === 'BX' && !index) return 7;
    if (!base && !index) return 6;
    throw new Error(`Unsupported 8086 addressing mode (base=${base || '-'}, index=${index || '-'})`);
  }

  // ModRM byte(s) for an r/m operand that may be a register or memory.
  function emitRM(regField, operand, ctx) {
    if (isReg(operand)) return [modrm(3, regField, operand.code)];
    if (operand.kind === 'mem') { const b = emitMem(regField, operand.mem, ctx); if (operand.seg) b.segPrefix = { ES: 0x26, CS: 0x2E, SS: 0x36, DS: 0x3E }[operand.seg]; return b; }
    throw new Error('Expected a register or memory operand');
  }

  function needSize(a, b, mnem) {
    if (isReg(a)) return regW(a);
    if (isReg(b)) return regW(b);
    if (a.kind === 'mem' && a.size != null) return a.size === 2 ? 1 : 0;
    if (b.kind === 'mem' && b.size != null) return b.size === 2 ? 1 : 0;
    throw new Error(`${mnem}: operand size not specified - write BYTE PTR or WORD PTR (e.g. ${mnem} WORD PTR [1234H],5)`);
  }
  function withPrefix(bytes) {
    let pre = [];
    for (const b of bytes) if (b && b.segPrefix) pre.push(b.segPrefix);
    return pre.length ? [pre[0], ...flat(bytes)] : flat(bytes);
  }
  function flat(arr) { const out = []; for (const x of arr) { if (Array.isArray(x)) out.push(...x); else out.push(x); } return out; }

  function encImm(v, w) { return w ? [v & 0xFF, (v >> 8) & 0xFF] : [v & 0xFF]; }

  function encode(mnemonic, operands, ctx) {
    const M = mnemonic.toUpperCase();

    // ---- prefixes: REP / REPE / REPNE <string-op> --------------------------
    if (M === 'REP' || M === 'REPE' || M === 'REPZ' || M === 'REPNE' || M === 'REPNZ') {
      if (!operands.length) throw new Error(`${M} must be followed by a string instruction, e.g. ${M} MOVSB`);
      const pfx = (M === 'REPNE' || M === 'REPNZ') ? 0xF2 : 0xF3;
      return [pfx, ...encode(operands[0], operands.slice(1), ctx)];
    }
    if (M === 'LOCK') { if (operands.length) return [0xF0, ...encode(operands[0], operands.slice(1), ctx)]; return [0xF0]; }

    if (M in STRING_OPC) { requireN(M, operands, 0); return [STRING_OPC[M][0]]; }
    if (M === 'INT3') return [0xCC];
    if (M in NO_OPERAND && M !== 'RET' && M !== 'RETF') { requireN(M, operands, 0); return [NO_OPERAND[M]]; }

    if (M === 'RET' || M === 'RETN' || M === 'RETF') {
      if (!operands.length) return [M === 'RETF' ? 0xCB : 0xC3];
      const v = resolveOperand(operands[0], ctx) & 0xFFFF;
      return [M === 'RETF' ? 0xCA : 0xC2, v & 0xFF, (v >> 8) & 0xFF];
    }

    // ---- MOV --------------------------------------------------------------
    if (M === 'MOV') {
      requireN(M, operands, 2);
      const d = classify(operands[0]), s = classify(operands[1]);
      if (d.kind === 'sreg' || s.kind === 'sreg') {
        const op = d.kind === 'sreg' ? 0x8E : 0x8C;
        const sregO = d.kind === 'sreg' ? d : s;
        const other = d.kind === 'sreg' ? s : d;
        if (other.kind === 'r16') return [op, modrm(3, sregO.code, other.code)];
        if (other.kind === 'mem') return withPrefix([op, emitRM(sregO.code, other, ctx)]);
        throw new Error('MOV with a segment register needs a 16-bit register or memory operand');
      }
      if (d.kind === 'r16' && s.kind === 'imm') { const v = resolveOperand(s.expr, ctx); return [0xB8 + d.code, v & 0xFF, (v >> 8) & 0xFF]; }
      if (d.kind === 'r8' && s.kind === 'imm') { const v = resolveOperand(s.expr, ctx); return [0xB0 + d.code, v & 0xFF]; }
      if (isReg(d) && isReg(s)) { if (regW(d) !== regW(s)) throw new Error(`MOV: size mismatch between ${d.text} and ${s.text}`); return [0x8A + regW(d), modrm(3, d.code, s.code)]; }
      if (isReg(d) && s.kind === 'mem') return withPrefix([0x8A + regW(d), emitRM(d.code, s, ctx)]);
      if (d.kind === 'mem' && isReg(s)) return withPrefix([0x88 + regW(s), emitRM(s.code, d, ctx)]);
      if (d.kind === 'mem' && s.kind === 'imm') {
        const w = needSize(d, s, 'MOV'); const v = resolveOperand(s.expr, ctx);
        return withPrefix([0xC6 + w, emitRM(0, d, ctx), encImm(v, w)]);
      }
      throw new Error(`Unsupported MOV: MOV ${operands.join(',')}`);
    }

    // ---- arithmetic / logic (ADD OR ADC SBB AND SUB XOR CMP) -------------
    if (M in ARITH_IDX) {
      requireN(M, operands, 2);
      const idx = ARITH_IDX[M];
      const d = classify(operands[0]), s = classify(operands[1]);
      if (isReg(d) && isReg(s)) { if (regW(d) !== regW(s)) throw new Error(`${M}: size mismatch between ${d.text} and ${s.text}`); return [idx * 8 + 2 + regW(d), modrm(3, d.code, s.code)]; }
      if (isReg(d) && s.kind === 'mem') return withPrefix([idx * 8 + 2 + regW(d), emitRM(d.code, s, ctx)]);
      if (d.kind === 'mem' && isReg(s)) return withPrefix([idx * 8 + 0 + regW(s), emitRM(s.code, d, ctx)]);
      if ((isReg(d) || d.kind === 'mem') && s.kind === 'imm') {
        const w = needSize(d, s, M); const v = resolveOperand(s.expr, ctx);
        return withPrefix([0x80 + w, emitRM(idx, d, ctx), encImm(v, w)]);
      }
      throw new Error(`Unsupported ${M}: ${M} ${operands.join(',')}`);
    }

    // ---- TEST -----------------------------------------------------------
    if (M === 'TEST') {
      requireN(M, operands, 2);
      const d = classify(operands[0]), s = classify(operands[1]);
      if (isReg(d) && isReg(s)) return [0x84 + regW(d), modrm(3, d.code, s.code)];
      if (isReg(d) && s.kind === 'mem') return withPrefix([0x84 + regW(d), emitRM(d.code, s, ctx)]);
      if (d.kind === 'mem' && isReg(s)) return withPrefix([0x84 + regW(s), emitRM(s.code, d, ctx)]);
      if ((isReg(d) || d.kind === 'mem') && s.kind === 'imm') { const w = needSize(d, s, M); const v = resolveOperand(s.expr, ctx); return withPrefix([0xF6 + w, emitRM(0, d, ctx), encImm(v, w)]); }
      throw new Error(`Unsupported TEST: TEST ${operands.join(',')}`);
    }

    // ---- XCHG ---------------------------------------------------------
    if (M === 'XCHG') {
      requireN(M, operands, 2);
      let d = classify(operands[0]), s = classify(operands[1]);
      if (d.kind === 'r16' && s.kind === 'r16' && (d.code === 0 || s.code === 0)) return [0x90 + (d.code === 0 ? s.code : d.code)];
      if (isReg(d) && isReg(s)) return [0x86 + regW(d), modrm(3, d.code, s.code)];
      if (d.kind === 'mem' && isReg(s)) return withPrefix([0x86 + regW(s), emitRM(s.code, d, ctx)]);
      if (isReg(d) && s.kind === 'mem') return withPrefix([0x86 + regW(d), emitRM(d.code, s, ctx)]);
      throw new Error(`Unsupported XCHG: XCHG ${operands.join(',')}`);
    }

    // ---- LEA --------------------------------------------------------
    if (M === 'LEA') {
      requireN(M, operands, 2);
      const d = classify(operands[0]), s = classify(operands[1]);
      if (d.kind !== 'r16' || s.kind !== 'mem') throw new Error('LEA needs a 16-bit register and a memory operand, e.g. LEA SI,[BX+2]');
      return withPrefix([0x8D, emitRM(d.code, s, ctx)]);
    }

    // ---- INC / DEC ------------------------------------------------
    if (M === 'INC' || M === 'DEC') {
      requireN(M, operands, 1);
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [(M === 'INC' ? 0x40 : 0x48) + o.code];
      if (o.kind === 'r8') return [0xFE, modrm(3, M === 'INC' ? 0 : 1, o.code)];
      if (o.kind === 'mem') {
        const w = o.size != null ? (o.size === 2 ? 1 : 0) : 1;
        return withPrefix([w ? 0xFF : 0xFE, emitRM(M === 'INC' ? 0 : 1, o, ctx)]);
      }
      throw new Error(`${M} needs a register or memory operand`);
    }

    // ---- NOT NEG MUL IMUL DIV IDIV ------------------------------
    if (['NOT', 'NEG', 'MUL', 'IMUL', 'DIV', 'IDIV'].includes(M)) {
      requireN(M, operands, 1);
      const rf = { NOT: 2, NEG: 3, MUL: 4, IMUL: 5, DIV: 6, IDIV: 7 }[M];
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [0xF7, modrm(3, rf, o.code)];
      if (o.kind === 'r8') return [0xF6, modrm(3, rf, o.code)];
      if (o.kind === 'mem') { const w = o.size != null ? (o.size === 2 ? 1 : 0) : 1; return withPrefix([w ? 0xF7 : 0xF6, emitRM(rf, o, ctx)]); }
      throw new Error(`${M} needs a register or memory operand`);
    }

    // ---- shifts / rotates --------------------------------------
    if (M in SHIFT_RF) {
      const rf = SHIFT_RF[M];
      const d = classify(operands[0]);
      const cnt = operands.length > 1 ? classify(operands[1]) : { kind: 'imm', expr: '1' };
      const w = isReg(d) ? regW(d) : (d.size === 2 ? 1 : d.size === 1 ? 0 : 1);
      if (!isReg(d) && d.kind !== 'mem') throw new Error(`${M} needs a register or memory operand`);
      if (cnt.kind === 'r8' && cnt.code === 1) return withPrefix([0xD2 + w, emitRM(rf, d, ctx)]);         // ,CL
      const c = cnt.kind === 'imm' ? resolveOperand(cnt.expr, ctx) : 1;
      if (c === 1) return withPrefix([0xD0 + w, emitRM(rf, d, ctx)]);
      return withPrefix([0xC0 + w, emitRM(rf, d, ctx), c & 0xFF]);                                          // ,imm8 (80186+)
    }

    // ---- PUSH / POP -------------------------------------------
    if (M === 'PUSH') {
      requireN(M, operands, 1);
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [0x50 + o.code];
      if (o.kind === 'sreg') return [[0x06, 0x0E, 0x16, 0x1E][o.code]];
      if (o.kind === 'mem') return withPrefix([0xFF, emitRM(6, o, ctx)]);
      if (o.kind === 'imm') { const v = resolveOperand(o.expr, ctx); return (v & 0xFF80) === 0 || (v & 0xFF80) === 0xFF80 ? [0x6A, v & 0xFF] : [0x68, v & 0xFF, (v >> 8) & 0xFF]; }
      throw new Error('Unsupported PUSH operand');
    }
    if (M === 'POP') {
      requireN(M, operands, 1);
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [0x58 + o.code];
      if (o.kind === 'sreg') { if (o.code === 1) throw new Error('POP CS is not a valid instruction'); return [[0x07, 0x0F, 0x17, 0x1F][o.code]]; }
      if (o.kind === 'mem') return withPrefix([0x8F, emitRM(0, o, ctx)]);
      throw new Error('Unsupported POP operand');
    }

    // ---- IN / OUT ------------------------------------------
    if (M === 'IN') {
      requireN(M, operands, 2);
      const a = classify(operands[0]), p = classify(operands[1]);
      const w = a.code === 0 && a.kind === 'r16' ? 1 : 0;
      if (p.kind === 'r16' && p.code === 2) return [0xEC + w];       // IN AL/AX,DX
      const port = resolveOperand(p.expr, ctx) & 0xFF;
      return [0xE4 + w, port];
    }
    if (M === 'OUT') {
      requireN(M, operands, 2);
      const p = classify(operands[0]), a = classify(operands[1]);
      const w = a.kind === 'r16' && a.code === 0 ? 1 : 0;
      if (p.kind === 'r16' && p.code === 2) return [0xEE + w];       // OUT DX,AL/AX
      const port = resolveOperand(p.expr, ctx) & 0xFF;
      return [0xE6 + w, port];
    }

    // ---- control transfer ---------------------------------
    if (M === 'JMP') {
      requireN(M, operands, 1);
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [0xFF, modrm(3, 4, o.code)];
      if (o.kind === 'mem') return withPrefix([0xFF, emitRM(4, o, ctx)]);
      const target = resolveOperand(o.expr, ctx);
      if (/^SHORT\b/i.test(o.expr)) { const rel = target - ((ctx.address + 2) & 0xFFFF); return [0xEB, rel & 0xFF]; }
      const rel = target - ((ctx.address + 3) & 0xFFFF);
      return [0xE9, rel & 0xFF, (rel >> 8) & 0xFF];
    }
    if (M === 'CALL') {
      requireN(M, operands, 1);
      const o = classify(operands[0]);
      if (o.kind === 'r16') return [0xFF, modrm(3, 2, o.code)];
      if (o.kind === 'mem') return withPrefix([0xFF, emitRM(2, o, ctx)]);
      const rel = resolveOperand(o.expr, ctx) - ((ctx.address + 3) & 0xFFFF);
      return [0xE8, rel & 0xFF, (rel >> 8) & 0xFF];
    }
    if (M === 'JCXZ') return shortBranch(0xE3, operands[0], ctx, false);
    if (M === 'LOOP') return shortBranch(0xE2, operands[0], ctx, false);
    if (M === 'LOOPE' || M === 'LOOPZ') return shortBranch(0xE1, operands[0], ctx, false);
    if (M === 'LOOPNE' || M === 'LOOPNZ') return shortBranch(0xE0, operands[0], ctx, false);
    if (M in JCC_OPC) return shortBranch(JCC_OPC[M], operands[0], ctx, true);

    if (M === 'INT') { requireN(M, operands, 1); const n = resolveOperand(operands[0], ctx) & 0xFF; return n === 3 ? [0xCC] : [0xCD, n]; }
    if (M === 'AAM') return [0xD4, operands.length ? resolveOperand(operands[0], ctx) & 0xFF : 0x0A];
    if (M === 'AAD') return [0xD5, operands.length ? resolveOperand(operands[0], ctx) & 0xFF : 0x0A];

    throw new Error(`Unknown or unsupported 8086 mnemonic '${M}'`);
  }

  function requireN(m, ops, n) { if (ops.length !== n) throw new Error(`${m} expects ${n} operand${n === 1 ? '' : 's'}, got ${ops.length}`); }

  // Short (8-bit displacement) branch, with automatic promotion to the long
  // form (inverted Jcc over a near JMP) when the target is out of range and the
  // assembler has marked this line for promotion.
  function shortBranch(opcode, targetTok, ctx, promotable) {
    if (targetTok == null) throw new Error('branch instruction needs a target label');
    const target = resolveOperand(targetTok, ctx);
    if (promotable && ctx.longBranches && ctx.lineNo != null && ctx.longBranches.has(ctx.lineNo)) {
      let rel = target - ((ctx.address + 5) & 0xFFFF);
      rel &= 0xFFFF;
      return [opcode ^ 1, 0x03, 0xE9, rel & 0xFF, (rel >> 8) & 0xFF];
    }
    let rel = target - ((ctx.address + 2) & 0xFFFF);
    if (rel > 0x7FFF) rel -= 0x10000; else if (rel < -0x8000) rel += 0x10000;
    if (ctx.pass === 2 && (rel < -128 || rel > 127)) {
      throw new Error(promotable
        ? `Branch target is ${rel} bytes away; the assembler could not fit it - restructure the jump`
        : `LOOP/JCXZ target is ${rel} bytes away but these instructions only allow -128..+127; use a conditional jump + JMP instead`);
    }
    return [opcode, rel & 0xFF];
  }

  // ============================ DECODER ============================

  function decodeOpcode(op) {
    if (op >= 0xB8 && op <= 0xBF) return { family: 'MOV_RI', w: 1, reg: op - 0xB8 };
    if (op >= 0xB0 && op <= 0xB7) return { family: 'MOV_RI', w: 0, reg: op - 0xB0 };
    if (op === 0x88 || op === 0x89 || op === 0x8A || op === 0x8B) return { family: 'MOV_RM', w: op & 1, dir: (op & 2) ? 'toReg' : 'toRM' };
    if (op === 0xC6 || op === 0xC7) return { family: 'MOV_MI', w: op & 1 };
    if (op === 0x8C) return { family: 'MOV_SR', dir: 'fromSreg' };
    if (op === 0x8E) return { family: 'MOV_SR', dir: 'toSreg' };
    if (op === 0x8D) return { family: 'LEA' };

    const ab = op & 0xC7, ag = (op >> 3) & 7;
    if (ab <= 0x03 && ag < 8 && (op & 0xC0) === 0) return { family: 'ARITH_RM', op: ARITH[ag], w: op & 1, dir: (op & 2) ? 'toReg' : 'toRM' };
    if ((op & 0xC7) === 0x04 || (op & 0xC7) === 0x05) { if (ag < 8) return { family: 'ARITH_AI', op: ARITH[ag], w: op & 1 }; }
    if (op === 0x80 || op === 0x81 || op === 0x82 || op === 0x83) return { family: 'ARITH_MI', w: op & 1, sx: (op === 0x83) };

    if (op === 0x84 || op === 0x85) return { family: 'TEST_RM', w: op & 1 };
    if (op === 0xA8 || op === 0xA9) return { family: 'TEST_AI', w: op & 1 };
    if (op === 0x86 || op === 0x87) return { family: 'XCHG_RM', w: op & 1 };
    if (op >= 0x91 && op <= 0x97) return { family: 'XCHG_AX', reg: op - 0x90 };

    if (op === 0xF6 || op === 0xF7) return { family: 'GRP3', w: op & 1 };
    if (op === 0xFE) return { family: 'GRP_FE', w: 0 };
    if (op === 0xFF) return { family: 'GRP_FF', w: 1 };
    if (op >= 0xD0 && op <= 0xD3) return { family: 'SHIFT', w: op & 1, countKind: (op & 2) ? 'CL' : '1' };
    if (op === 0xC0 || op === 0xC1) return { family: 'SHIFT', w: op & 1, countKind: 'imm8' };

    if (op >= 0x40 && op <= 0x47) return { family: 'INCDEC_R', reg: op - 0x40, delta: +1 };
    if (op >= 0x48 && op <= 0x4F) return { family: 'INCDEC_R', reg: op - 0x48, delta: -1 };

    if (op >= 0x50 && op <= 0x57) return { family: 'PUSH_R', reg: op - 0x50 };
    if (op >= 0x58 && op <= 0x5F) return { family: 'POP_R', reg: op - 0x58 };
    if (op === 0x9C) return { family: 'PUSHF' };
    if (op === 0x9D) return { family: 'POPF' };
    if (op === 0x60) return { family: 'PUSHA' };
    if (op === 0x61) return { family: 'POPA' };
    if (op === 0x68) return { family: 'PUSH_I', w: 1 };
    if (op === 0x6A) return { family: 'PUSH_I', w: 0 };
    if (op === 0x06 || op === 0x0E || op === 0x16 || op === 0x1E) return { family: 'PUSH_SR', sreg: (op >> 3) & 3 };
    if (op === 0x07 || op === 0x17 || op === 0x1F) return { family: 'POP_SR', sreg: (op >> 3) & 3 };

    if (op === 0xE9) return { family: 'JMP_D', w: 1 };
    if (op === 0xEB) return { family: 'JMP_D', w: 0 };
    if (op === 0xE8) return { family: 'CALL_D' };
    if (op === 0xC3) return { family: 'RET' };
    if (op === 0xC2) return { family: 'RET', imm: true };
    if (op === 0xCB) return { family: 'RET', far: true };
    if (op === 0xCA) return { family: 'RET', far: true, imm: true };

    if (op >= 0x70 && op <= 0x7F) return { family: 'JCC', cond: JCC_CANON[op] };
    if (op === 0xE3) return { family: 'JCXZ' };
    if (op === 0xE2) return { family: 'LOOP', kind: 'LOOP' };
    if (op === 0xE1) return { family: 'LOOP', kind: 'LOOPE' };
    if (op === 0xE0) return { family: 'LOOP', kind: 'LOOPNE' };

    if (op === 0xCD) return { family: 'INT' };
    if (op === 0xCC) return { family: 'INT', n3: true };
    if (op === 0xCE) return { family: 'INTO' };
    if (op === 0xCF) return { family: 'IRET' };

    if (op >= 0xA4 && op <= 0xAF) {
      const names = { 0xA4: 'MOVS', 0xA5: 'MOVS', 0xA6: 'CMPS', 0xA7: 'CMPS', 0xAA: 'STOS', 0xAB: 'STOS', 0xAC: 'LODS', 0xAD: 'LODS', 0xAE: 'SCAS', 0xAF: 'SCAS' };
      if (names[op]) return { family: 'STRING', sop: names[op], w: op & 1 };
    }
    if (op === 0xD7) return { family: 'XLAT' };
    if (op === 0x27) return { family: 'BCDADJ', kind: 'DAA' };
    if (op === 0x2F) return { family: 'BCDADJ', kind: 'DAS' };
    if (op === 0x37) return { family: 'BCDADJ', kind: 'AAA' };
    if (op === 0x3F) return { family: 'BCDADJ', kind: 'AAS' };
    if (op === 0xD4) return { family: 'ASCADJ', kind: 'AAM' };
    if (op === 0xD5) return { family: 'ASCADJ', kind: 'AAD' };
    if (op === 0x98) return { family: 'CBW' };
    if (op === 0x99) return { family: 'CWD' };
    if (op === 0x90) return { family: 'NOP' };
    if (op === 0xF4) return { family: 'HLT' };
    if (op === 0x9B) return { family: 'NOP' };            // WAIT - nothing to wait for here
    if (op in {}) {}
    if ([0xF5, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD].includes(op)) return { family: 'FLAGOP', op };
    if (op === 0xE4 || op === 0xE5) return { family: 'IN', w: op & 1, imm: true };
    if (op === 0xEC || op === 0xED) return { family: 'IN', w: op & 1, imm: false };
    if (op === 0xE6 || op === 0xE7) return { family: 'OUT', w: op & 1, imm: true };
    if (op === 0xEE || op === 0xEF) return { family: 'OUT', w: op & 1, imm: false };

    return { family: 'UNKNOWN', op };
  }

  // ============================ RUNTIME ============================

  function createCPU(memory) {
    return {
      arch: '8086',
      regs: { AX: 0, CX: 0, DX: 0, BX: 0, SP: 0xFFFE, BP: 0, SI: 0, DI: 0, IP: 0, ES: 0, CS: 0, SS: 0, DS: 0 },
      flags: { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0, DF: 0, IF: 0 },
      memory,
      halted: false,
      stage: 'FETCH',
      pending: {},
      cycles: 0,
      io: new Uint8Array(0x10000),
      outputLog: [],
      consoleText: '',
      trace: [],
      lastError: null,
    };
  }

  const mask = w => (w ? 0xFFFF : 0xFF);
  const sbit = w => (w ? 0x8000 : 0x80);
  function get8(regs, code) { const [p, half] = REG8_PARENT[code]; return half === 'lo' ? regs[p] & 0xFF : (regs[p] >> 8) & 0xFF; }
  function put8(writes, cur, code, val) {
    const [p, half] = REG8_PARENT[code]; val &= 0xFF;
    const base = writes.regs[p] !== undefined ? writes.regs[p] : cur[p];
    writes.regs[p] = half === 'lo' ? (base & 0xFF00) | val : (base & 0x00FF) | (val << 8);
  }
  function rd16(mem, a) { return mem[a & 0xFFFF] | (mem[(a + 1) & 0xFFFF] << 8); }

  function readModRM(cpu, u8, s8, s16, u16, w) {
    const byte = u8();
    const mod = (byte >> 6) & 3, reg = (byte >> 3) & 7, rm = byte & 7;
    if (mod === 3) return { isMem: false, reg, rm, w, regCode: rm };
    let disp = 0;
    if (mod === 1) disp = s8();
    else if (mod === 2) disp = s16();
    else if (mod === 0 && rm === 6) disp = u16();
    const R = cpu.regs;
    let ea;
    switch (rm) {
      case 0: ea = R.BX + R.SI; break;
      case 1: ea = R.BX + R.DI; break;
      case 2: ea = R.BP + R.SI; break;
      case 3: ea = R.BP + R.DI; break;
      case 4: ea = R.SI; break;
      case 5: ea = R.DI; break;
      case 6: ea = (mod === 0) ? 0 : R.BP; break;
      case 7: ea = R.BX; break;
    }
    return { isMem: true, reg, rm, w, addr: (ea + disp) & 0xFFFF };
  }

  function fetchOperands(cpu) {
    const d = cpu.pending.decoded, mem = cpu.memory;
    let ip = cpu.regs.IP;
    const u8 = () => { const v = mem[ip]; ip = (ip + 1) & 0xFFFF; return v; };
    const s8 = () => { const v = u8(); return v > 127 ? v - 256 : v; };
    const u16 = () => { const lo = u8(), hi = u8(); return (hi << 8) | lo; };
    const s16 = () => { const v = u16(); return v > 32767 ? v - 65536 : v; };
    const RM = (w) => readModRM(cpu, u8, s8, s16, u16, w);

    switch (d.family) {
      case 'MOV_RI': d.imm = d.w ? u16() : u8(); break;
      case 'MOV_RM': case 'ARITH_RM': case 'TEST_RM': case 'XCHG_RM': d.rm = RM(d.w); break;
      case 'LEA': d.rm = RM(1); break;
      case 'MOV_SR': d.rm = RM(1); break;
      case 'MOV_MI': d.rm = RM(d.w); d.imm = d.w ? u16() : u8(); break;
      case 'ARITH_MI': d.rm = RM(d.w); d.imm = d.sx ? (s8() & (d.w ? 0xFFFF : 0xFF)) : (d.w ? u16() : u8()); d.op = ARITH[d.rm.reg]; break;
      case 'ARITH_AI': case 'TEST_AI': d.imm = d.w ? u16() : u8(); break;
      case 'GRP3': d.rm = RM(d.w); d.sub = GRP3_NAME[d.rm.reg]; if (d.rm.reg < 2) d.imm = d.w ? u16() : u8(); break;
      case 'GRP_FE': d.rm = RM(0); break;
      case 'GRP_FF': d.rm = RM(1); break;
      case 'SHIFT': d.rm = RM(d.w); d.sub = SHIFT_NAME[d.rm.reg]; if (d.countKind === 'imm8') d.count = u8(); break;
      case 'PUSH_I': d.imm = d.w ? u16() : ((u8() << 24) >> 24) & 0xFFFF; break;
      case 'JMP_D': d.rel = d.w ? s16() : s8(); break;
      case 'CALL_D': d.rel = s16(); break;
      case 'JCC': case 'JCXZ': case 'LOOP': d.rel = s8(); break;
      case 'RET': if (d.imm) d.pop = u16(); break;
      case 'ASCADJ': d.base = u8(); break;
      case 'INT': d.n = d.n3 ? 3 : u8(); break;
      case 'IN': case 'OUT': if (d.imm) d.port = u8(); break;
    }
    cpu.regs.IP = ip;
    cpu.pending.afterFetchIP = ip;

    // materialise r/m and reg values
    const R = cpu.regs;
    if (d.rm) {
      if (d.rm.isMem) d.rmVal = d.rm.w ? rd16(mem, d.rm.addr) : mem[d.rm.addr];
      else d.rmVal = d.rm.w ? R[REG16_NAMES[d.rm.rm]] : get8(R, d.rm.rm);
      if (d.family === 'MOV_RM' || d.family === 'ARITH_RM' || d.family === 'TEST_RM' || d.family === 'XCHG_RM')
        d.regVal = d.rm.w ? R[REG16_NAMES[d.rm.reg]] : get8(R, d.rm.reg);
      if (d.family === 'MOV_SR') d.regVal = R[SREG_NAMES[d.rm.reg]];
    }
    if (d.family === 'JMP_D' || d.family === 'CALL_D' || d.family === 'JCC' || d.family === 'JCXZ' || d.family === 'LOOP')
      d.targetAddr = (ip + d.rel) & 0xFFFF;
  }

  // ---- flag helpers ----
  function setSZP(w, res, F) { F.ZF = (res & mask(w)) === 0 ? 1 : 0; F.SF = (res & sbit(w)) ? 1 : 0; F.PF = parity8(res & 0xFF); }
  function doArith(op, a, b, w, F) {
    const mk = mask(w), sb = sbit(w);
    let r, cf = F.CF, af = F.AF, of = F.OF;
    switch (op) {
      case 'ADD': { const s = a + b; r = s & mk; cf = s > mk ? 1 : 0; af = ((a & 0xF) + (b & 0xF)) > 0xF ? 1 : 0; of = ((~(a ^ b)) & (a ^ r) & sb) ? 1 : 0; break; }
      case 'ADC': { const c = F.CF, s = a + b + c; r = s & mk; cf = s > mk ? 1 : 0; af = ((a & 0xF) + (b & 0xF) + c) > 0xF ? 1 : 0; of = ((~(a ^ b)) & (a ^ r) & sb) ? 1 : 0; break; }
      case 'SUB': case 'CMP': { const s = a - b; r = s & mk; cf = s < 0 ? 1 : 0; af = ((a & 0xF) - (b & 0xF)) < 0 ? 1 : 0; of = ((a ^ b) & (a ^ r) & sb) ? 1 : 0; break; }
      case 'SBB': { const c = F.CF, s = a - b - c; r = s & mk; cf = s < 0 ? 1 : 0; af = ((a & 0xF) - (b & 0xF) - c) < 0 ? 1 : 0; of = ((a ^ b) & (a ^ r) & sb) ? 1 : 0; break; }
      case 'AND': case 'TEST': r = (a & b) & mk; cf = 0; of = 0; af = 0; break;
      case 'OR': r = (a | b) & mk; cf = 0; of = 0; af = 0; break;
      case 'XOR': r = (a ^ b) & mk; cf = 0; of = 0; af = 0; break;
    }
    F.CF = cf; F.AF = af; F.OF = of; setSZP(w, r, F);
    return r;
  }
  function condJcc(cond, F) {
    switch (cond) {
      case 'JO': return !!F.OF; case 'JNO': return !F.OF;
      case 'JB': return !!F.CF; case 'JAE': return !F.CF;
      case 'JE': return !!F.ZF; case 'JNE': return !F.ZF;
      case 'JBE': return !!(F.CF || F.ZF); case 'JA': return !(F.CF || F.ZF);
      case 'JS': return !!F.SF; case 'JNS': return !F.SF;
      case 'JP': return !!F.PF; case 'JNP': return !F.PF;
      case 'JL': return F.SF !== F.OF; case 'JGE': return F.SF === F.OF;
      case 'JLE': return !!(F.ZF || (F.SF !== F.OF)); case 'JG': return !F.ZF && (F.SF === F.OF);
    }
    return false;
  }
  function packFlags(F) { return 0xF002 | (F.CF) | (F.PF << 2) | (F.AF << 4) | (F.ZF << 6) | (F.SF << 7) | (F.OF << 11) | (F.DF << 10) | (F.IF << 9); }
  function unpackFlags(v) { return { CF: v & 1, PF: (v >> 2) & 1, AF: (v >> 4) & 1, ZF: (v >> 6) & 1, SF: (v >> 7) & 1, IF: (v >> 9) & 1, DF: (v >> 10) & 1, OF: (v >> 11) & 1 }; }

  function doShift(sub, val, cnt, w, F) {
    const mk = mask(w), bits = w ? 16 : 8;
    let n = cnt & 0x1F;
    if (n === 0) return val & mk;
    let v = val & mk, cf = F.CF;
    for (let k = 0; k < n; k++) {
      if (sub === 'SHL' || sub === 'SAL') { cf = (v & sbit(w)) ? 1 : 0; v = (v << 1) & mk; }
      else if (sub === 'SHR') { cf = v & 1; v = v >>> 1; }
      else if (sub === 'SAR') { cf = v & 1; v = (v >>> 1) | (v & sbit(w)); }
      else if (sub === 'ROL') { cf = (v & sbit(w)) ? 1 : 0; v = ((v << 1) | cf) & mk; }
      else if (sub === 'ROR') { cf = v & 1; v = ((v >>> 1) | (cf << (bits - 1))) & mk; }
      else if (sub === 'RCL') { const nc = (v & sbit(w)) ? 1 : 0; v = ((v << 1) | cf) & mk; cf = nc; }
      else if (sub === 'RCR') { const nc = v & 1; v = ((v >>> 1) | (cf << (bits - 1))) & mk; cf = nc; }
    }
    F.CF = cf;
    if (sub === 'SHL' || sub === 'SAL' || sub === 'SHR' || sub === 'SAR') setSZP(w, v, F);
    if (n === 1) {
      if (sub === 'SHL' || sub === 'SAL') F.OF = ((v & sbit(w)) ? 1 : 0) ^ cf;
      else if (sub === 'SHR') F.OF = (val & sbit(w)) ? 1 : 0;
      else if (sub === 'SAR') F.OF = 0;
      else if (sub === 'ROL' || sub === 'RCL') F.OF = ((v & sbit(w)) ? 1 : 0) ^ cf;
      else if (sub === 'ROR' || sub === 'RCR') F.OF = (((v >> (bits - 1)) & 1) ^ ((v >> (bits - 2)) & 1));
    }
    return v & mk;
  }

  function execute(cpu) {
    const d = cpu.pending.decoded, R = cpu.regs, F = cpu.flags;
    const w = { regs: {}, mem: {}, flags: {}, sregs: {} };
    cpu.pending.writes = w;
    const Fw = Object.assign({}, F);   // working copy for flag-producing ops

    const setReg = (code, val, wide) => wide ? (w.regs[REG16_NAMES[code]] = val & 0xFFFF) : put8(w, R, code, val);
    const writeRM = (rm, val) => {
      if (rm.isMem) { w.mem[rm.addr & 0xFFFF] = val & 0xFF; if (rm.w) w.mem[(rm.addr + 1) & 0xFFFF] = (val >> 8) & 0xFF; }
      else setReg(rm.rm, val, rm.w);
    };
    const push16 = (val) => { const sp = (R.SP - 2) & 0xFFFF; w.mem[sp] = val & 0xFF; w.mem[(sp + 1) & 0xFFFF] = (val >> 8) & 0xFF; w.sp = sp; };
    const pop16 = () => { const sp = (w.sp !== undefined ? w.sp : R.SP); const v = rd16(cpu.memory, sp); w.sp = (sp + 2) & 0xFFFF; return v; };

    switch (d.family) {
      case 'NOP': break;
      case 'HLT': w.halt = true; break;

      case 'MOV_RI': setReg(d.reg, d.imm, d.w); break;
      case 'MOV_RM': if (d.dir === 'toReg') setReg(d.rm.reg, d.rmVal, d.rm.w); else writeRM(d.rm, d.regVal); break;
      case 'MOV_MI': writeRM(d.rm, d.imm); break;
      case 'MOV_SR':
        if (d.dir === 'toSreg') w.sregs[SREG_NAMES[d.rm.reg]] = d.rmVal & 0xFFFF;
        else writeRM(d.rm, R[SREG_NAMES[d.rm.reg]]);
        break;
      case 'LEA': w.regs[REG16_NAMES[d.rm.reg]] = d.rm.addr & 0xFFFF; break;

      case 'ARITH_RM': {
        const a = d.dir === 'toReg' ? d.regVal : d.rmVal;
        const b = d.dir === 'toReg' ? d.rmVal : d.regVal;
        const r = doArith(d.op, a & mask(d.w), b & mask(d.w), d.w, Fw);
        if (d.op !== 'CMP') { if (d.dir === 'toReg') setReg(d.rm.reg, r, d.rm.w); else writeRM(d.rm, r); }
        w.flags = Fw; break;
      }
      case 'ARITH_MI': {
        const r = doArith(d.op, d.rmVal & mask(d.w), d.imm & mask(d.w), d.w, Fw);
        if (d.op !== 'CMP') writeRM(d.rm, r);
        w.flags = Fw; break;
      }
      case 'ARITH_AI': {
        const acc = d.w ? R.AX : (R.AX & 0xFF);
        const r = doArith(d.op, acc, d.imm & mask(d.w), d.w, Fw);
        if (d.op !== 'CMP') setReg(0, r, d.w);
        w.flags = Fw; break;
      }
      case 'TEST_RM': doArith('TEST', d.regVal & mask(d.w), d.rmVal & mask(d.w), d.w, Fw); w.flags = Fw; break;
      case 'TEST_AI': doArith('TEST', (d.w ? R.AX : R.AX & 0xFF), d.imm & mask(d.w), d.w, Fw); w.flags = Fw; break;

      case 'XCHG_RM': {
        const tmp = d.rmVal;
        writeRM(d.rm, d.regVal);
        setReg(d.rm.reg, tmp, d.rm.w);
        break;
      }
      case 'XCHG_AX': { const other = R[REG16_NAMES[d.reg]]; w.regs.AX = other; w.regs[REG16_NAMES[d.reg]] = R.AX; break; }

      case 'INCDEC_R': {
        const v = (R[REG16_NAMES[d.reg]] + d.delta) & 0xFFFF;
        w.regs[REG16_NAMES[d.reg]] = v;
        incDecFlags(v, 1, d.delta > 0, Fw); w.flags = Fw; break;
      }
      case 'GRP_FE': case 'GRP_FF': {
        const isInc = d.rm.reg === 0;
        if (d.rm.reg <= 1) {
          const v = (d.rmVal + (isInc ? 1 : -1)) & mask(d.rm.w);
          writeRM(d.rm, v); incDecFlags(v, d.rm.w, isInc, Fw); w.flags = Fw;
        } else if (d.rm.reg === 6 && d.family === 'GRP_FF') {  // PUSH r/m16
          push16(d.rmVal);
        } else if (d.rm.reg === 2 && d.family === 'GRP_FF') {  // CALL near indirect
          push16(cpu.regs.IP); w.ip = d.rmVal & 0xFFFF;
        } else if (d.rm.reg === 4 && d.family === 'GRP_FF') {  // JMP near indirect
          w.ip = d.rmVal & 0xFFFF;
        }
        break;
      }
      case 'GRP3': {
        const rf = d.rm.reg;
        if (rf < 2) { doArith('TEST', d.rmVal & mask(d.w), d.imm & mask(d.w), d.w, Fw); w.flags = Fw; }
        else if (rf === 2) writeRM(d.rm, (~d.rmVal) & mask(d.w));
        else if (rf === 3) { const v = (-(d.rmVal)) & mask(d.w); writeRM(d.rm, v); doArith('SUB', 0, d.rmVal & mask(d.w), d.w, Fw); w.flags = Fw; }
        else if (rf === 4 || rf === 5) {                         // MUL / IMUL
          let src = d.rmVal & mask(d.w), a = d.w ? R.AX : (R.AX & 0xFF);
          if (rf === 5) { src = signed(src, d.w); a = signed(a, d.w); }
          const prod = a * src;
          if (!d.w) { w.regs.AX = prod & 0xFFFF; const up = (prod >> 8) & 0xFF; const set = rf === 4 ? up !== 0 : (prod < -128 || prod > 127); Fw.CF = Fw.OF = set ? 1 : 0; }
          else { const p = prod >>> 0 === prod ? prod : prod; w.regs.AX = p & 0xFFFF; w.regs.DX = (Math.floor(p / 65536) & 0xFFFF); const set = rf === 4 ? (w.regs.DX !== 0) : (prod < -32768 || prod > 32767); Fw.CF = Fw.OF = set ? 1 : 0; }
          w.flags = Fw;
        }
        else {                                                   // DIV / IDIV
          const src = d.rmVal & mask(d.w);
          if (src === 0) throw new CpuRuntimeError('Divide error: division by zero');
          if (!d.w) {
            let num = R.AX; let dv = src;
            if (rf === 7) { num = signed(num, 1); dv = signed(src, 0); }
            const q = Math.trunc(num / dv), rem = num % dv;
            if (rf === 6 ? (q > 0xFF) : (q > 127 || q < -128)) throw new CpuRuntimeError('Divide error: quotient does not fit in 8 bits');
            w.regs.AX = ((rem & 0xFF) << 8) | (q & 0xFF);
          } else {
            let num = (R.DX * 65536) + R.AX; let dv = src;
            if (rf === 7) { num = signed32(num); dv = signed(src, 1); }
            const q = Math.trunc(num / dv), rem = num % dv;
            if (rf === 6 ? (q > 0xFFFF) : (q > 32767 || q < -32768)) throw new CpuRuntimeError('Divide error: quotient does not fit in 16 bits');
            w.regs.AX = q & 0xFFFF; w.regs.DX = rem & 0xFFFF;
          }
        }
        break;
      }
      case 'SHIFT': {
        const cnt = d.countKind === 'CL' ? (R.CX & 0xFF) : d.countKind === 'imm8' ? d.count : 1;
        const v = doShift(d.sub, d.rmVal, cnt, d.w, Fw);
        writeRM(d.rm, v); w.flags = Fw; break;
      }

      case 'PUSH_R': push16(R[REG16_NAMES[d.reg]]); break;
      case 'POP_R': w.regs[REG16_NAMES[d.reg]] = pop16(); break;
      case 'PUSH_I': push16(d.imm); break;
      case 'PUSHF': push16(packFlags(F)); break;
      case 'POPF': w.flags = unpackFlags(pop16()); break;
      case 'PUSH_SR': push16(R[SREG_NAMES[d.sreg]]); break;
      case 'POP_SR': w.sregs[SREG_NAMES[d.sreg]] = pop16(); break;
      case 'PUSHA': { const o = R.SP; [R.AX, R.CX, R.DX, R.BX, o, R.BP, R.SI, R.DI].forEach(push16); break; }
      case 'POPA': { const g = ['DI', 'SI', 'BP', 'SP', 'BX', 'DX', 'CX', 'AX']; for (const n of g) { const v = pop16(); if (n !== 'SP') w.regs[n] = v; } break; }

      case 'JMP_D': w.ip = d.targetAddr; break;
      case 'CALL_D': push16(cpu.regs.IP); w.ip = d.targetAddr; break;
      case 'RET': { const t = pop16(); w.ip = t; if (d.far) pop16(); if (d.imm) w.sp = ((w.sp !== undefined ? w.sp : R.SP) + d.pop) & 0xFFFF; break; }
      case 'IRET': { w.ip = pop16(); pop16(); w.flags = unpackFlags(pop16()); break; }

      case 'JCC': if (condJcc(d.cond, F)) w.ip = d.targetAddr; break;
      case 'JCXZ': if ((R.CX & 0xFFFF) === 0) w.ip = d.targetAddr; break;
      case 'LOOP': {
        const cx = (R.CX - 1) & 0xFFFF; w.regs.CX = cx;
        const take = d.kind === 'LOOP' ? cx !== 0 : d.kind === 'LOOPE' ? (cx !== 0 && F.ZF) : (cx !== 0 && !F.ZF);
        if (take) w.ip = d.targetAddr;
        break;
      }

      case 'INT': doInterrupt(cpu, d.n, w); break;
      case 'INTO': if (F.OF) doInterrupt(cpu, 4, w); break;

      case 'CBW': { const al = R.AX & 0xFF; w.regs.AX = (al & 0x80) ? (0xFF00 | al) : al; break; }
      case 'CWD': w.regs.DX = (R.AX & 0x8000) ? 0xFFFF : 0x0000; break;
      case 'XLAT': w.regs.AX = (R.AX & 0xFF00) | cpu.memory[(R.BX + (R.AX & 0xFF)) & 0xFFFF]; break;

      case 'BCDADJ': {
        let al = R.AX & 0xFF, ah = (R.AX >> 8) & 0xFF, cf = F.CF, af = F.AF;
        if (d.kind === 'DAA' || d.kind === 'DAS') {
          const sub = d.kind === 'DAS';
          const oldAl = al, oldCf = cf; cf = 0;
          if ((al & 0x0F) > 9 || af) { al = sub ? al - 6 : al + 6; cf = oldCf || (al < 0 || al > 0xFF) ? 1 : 0; af = 1; } else af = 0;
          if (oldAl > 0x99 || oldCf) { al = sub ? al - 0x60 : al + 0x60; cf = 1; }
          al &= 0xFF;
          Fw.CF = cf; Fw.AF = af; setSZP(0, al, Fw);
          w.regs.AX = (ah << 8) | al; w.flags = Fw;
        } else {                                  // AAA / AAS
          const sub = d.kind === 'AAS';
          if ((al & 0x0F) > 9 || af) { al = (sub ? al - 6 : al + 6) & 0xFF; ah = (sub ? ah - 1 : ah + 1) & 0xFF; af = 1; cf = 1; } else { af = 0; cf = 0; }
          al &= 0x0F;
          Fw.CF = cf; Fw.AF = af; setSZP(0, al, Fw);
          w.regs.AX = (ah << 8) | al; w.flags = Fw;
        }
        break;
      }
      case 'ASCADJ': {
        const base = d.base || 10;
        let al = R.AX & 0xFF, ah = (R.AX >> 8) & 0xFF;
        if (d.kind === 'AAM') { ah = Math.floor(al / base) & 0xFF; al = (al % base) & 0xFF; }
        else { al = (ah * base + al) & 0xFF; ah = 0; }         // AAD
        setSZP(0, al, Fw); Fw.CF = F.CF; Fw.OF = F.OF; Fw.AF = F.AF;
        w.regs.AX = (ah << 8) | al; w.flags = Fw;
        break;
      }

      case 'FLAGOP':
        if (d.op === 0xF8) w.flags = { CF: 0 };
        else if (d.op === 0xF9) w.flags = { CF: 1 };
        else if (d.op === 0xF5) w.flags = { CF: F.CF ? 0 : 1 };
        else if (d.op === 0xFC) w.flags = { DF: 0 };
        else if (d.op === 0xFD) w.flags = { DF: 1 };
        else if (d.op === 0xFA) w.flags = { IF: 0 };
        else if (d.op === 0xFB) w.flags = { IF: 1 };
        break;

      case 'IN': { const port = d.imm ? d.port : (R.DX & 0xFFFF); const v = d.w ? (cpu.io[port] | (cpu.io[(port + 1) & 0xFFFF] << 8)) : cpu.io[port]; setReg(0, v, d.w); break; }
      case 'OUT': { const port = d.imm ? d.port : (R.DX & 0xFFFF); const v = d.w ? R.AX : (R.AX & 0xFF); w.ioOut = { port, value: v, w: d.w }; break; }

      case 'STRING': runString(cpu, d, w); break;

      case 'UNKNOWN':
        throw new CpuRuntimeError(`Unimplemented opcode ${hex2(d.op)}H at ${hex4(cpu.pending.startIP)}H`);
      default: break;
    }
  }

  function signed(v, w) { const s = w ? 0x8000 : 0x80, m = w ? 0x10000 : 0x100; v &= (m - 1); return v & s ? v - m : v; }
  function signed32(v) { v = v >>> 0; return v & 0x80000000 ? v - 0x100000000 : v; }
  function incDecFlags(res, w, isInc, F) {
    setSZP(w, res, F);
    F.AF = isInc ? ((res & 0xF) === 0 ? 1 : 0) : ((res & 0xF) === 0xF ? 1 : 0);
    F.OF = (res === (isInc ? sbit(w) : (mask(w) >> 1))) ? 1 : 0;
  }

  function runString(cpu, d, w) {
    const R = cpu.regs, F = cpu.flags, mem = cpu.memory;
    const wide = d.w, delta = (F.DF ? -1 : 1) * (wide ? 2 : 1);
    const rep = cpu.pending.decoded.rep;   // null | 'REP' | 'REPNE'
    let si = R.SI, di = R.DI, cx = R.CX;
    const Fw = Object.assign({}, F);
    const rd = (a) => wide ? rd16(mem, a) : mem[a & 0xFFFF];
    const wr = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; if (wide) mem[(a + 1) & 0xFFFF] = (v >> 8) & 0xFF; };
    let iterations = rep ? cx : 1;
    let guard = 0x20000;
    while (iterations > 0 && guard-- > 0) {
      if (rep && cx === 0) break;
      switch (d.sop) {
        case 'MOVS': wr(di, rd(si)); si = (si + delta) & 0xFFFF; di = (di + delta) & 0xFFFF; break;
        case 'STOS': wr(di, wide ? R.AX : (R.AX & 0xFF)); di = (di + delta) & 0xFFFF; break;
        case 'LODS': { const v = rd(si); if (wide) R.AX = v & 0xFFFF; else R.AX = (R.AX & 0xFF00) | (v & 0xFF); si = (si + delta) & 0xFFFF; break; }
        case 'SCAS': { doArith('CMP', (wide ? R.AX : R.AX & 0xFF) & mask(wide), rd(di) & mask(wide), wide, Fw); di = (di + delta) & 0xFFFF; break; }
        case 'CMPS': { doArith('CMP', rd(si) & mask(wide), rd(di) & mask(wide), wide, Fw); si = (si + delta) & 0xFFFF; di = (di + delta) & 0xFFFF; break; }
      }
      if (rep) cx = (cx - 1) & 0xFFFF;
      iterations--;
      if (rep && (d.sop === 'SCAS' || d.sop === 'CMPS')) {
        if (rep === 'REP' && !Fw.ZF) break;       // REPE: stop when ZF=0
        if (rep === 'REPNE' && Fw.ZF) break;       // REPNE: stop when ZF=1
      }
      if (!rep) break;
    }
    w.regs.SI = si & 0xFFFF; w.regs.DI = di & 0xFFFF;
    if (rep) w.regs.CX = cx & 0xFFFF;
    if (d.sop === 'SCAS' || d.sop === 'CMPS') w.flags = Fw;
    if (d.sop === 'LODS') w.regs.AX = R.AX & 0xFFFF;
  }

  function doInterrupt(cpu, n, w) {
    const R = cpu.regs;
    if (n === 0x20) { w.halt = true; return; }
    if (n === 0x21) {
      const ah = (R.AX >> 8) & 0xFF;
      if (ah === 0x4C) { w.halt = true; return; }
      if (ah === 0x01 || ah === 0x07 || ah === 0x08) { w.regs.AX = (R.AX & 0xFF00); return; }   // no stdin here
      if (ah === 0x02) { w.consoleOut = String.fromCharCode(R.DX & 0xFF); return; }
      if (ah === 0x06) { if ((R.DX & 0xFF) !== 0xFF) w.consoleOut = String.fromCharCode(R.DX & 0xFF); else w.regs.AX = (R.AX & 0xFF00); return; }
      if (ah === 0x09) {
        let a = R.DX, s = '';
        while (cpu.memory[a & 0xFFFF] !== 0x24 && s.length < 1024) { s += String.fromCharCode(cpu.memory[a & 0xFFFF]); a = (a + 1) & 0xFFFF; }
        w.consoleOut = s; return;
      }
      w.note = `INT 21H service AH=${hex2(ah)}H is not simulated (supported: 01/02/06/07/08/09/4C)`; return;
    }
    if (n === 0x10) {
      const ah = (R.AX >> 8) & 0xFF;
      if (ah === 0x0E) { w.consoleOut = String.fromCharCode(R.AX & 0xFF); return; }
      w.note = `INT 10H service AH=${hex2(ah)}H is not simulated (supported: 0E teletype)`; return;
    }
    if (n === 3) { w.note = 'INT 3 (breakpoint)'; return; }
    w.halt = true; w.note = `INT ${hex2(n)}H is not implemented by this trainer; halting`;
  }

  function writeback(cpu) {
    const w = cpu.pending.writes, d = cpu.pending.decoded;
    Object.assign(cpu.regs, w.regs);
    if (w.sregs) for (const k in w.sregs) cpu.regs[k] = w.sregs[k] & 0xFFFF;
    for (const a in w.mem) cpu.memory[a & 0xFFFF] = w.mem[a] & 0xFF;
    if (w.flags) Object.assign(cpu.flags, w.flags);
    if (w.sp !== undefined) cpu.regs.SP = w.sp & 0xFFFF;
    if (w.ip !== undefined) cpu.regs.IP = w.ip & 0xFFFF;
    if (w.ioOut) {
      cpu.io[w.ioOut.port] = w.ioOut.value & 0xFF;
      if (w.ioOut.w) cpu.io[(w.ioOut.port + 1) & 0xFFFF] = (w.ioOut.value >> 8) & 0xFF;
      cpu.outputLog.push({ port: w.ioOut.port, value: w.ioOut.value, w: w.ioOut.w, cycle: cpu.cycles });
    }
    if (w.consoleOut) { cpu.consoleText += w.consoleOut; cpu.outputLog.push({ text: w.consoleOut, cycle: cpu.cycles }); }
    cpu.cycles++;
    const len = Math.max(1, (cpu.pending.afterFetchIP - cpu.pending.startIP + 0x10000) % 0x10000);
    const bytes = [];
    for (let i = 0; i < len && i < 8; i++) bytes.push(cpu.memory[(cpu.pending.startIP + i) & 0xFFFF]);
    cpu.trace.push({ pc: cpu.pending.startIP, bytes, text: disasmText(d) });
    if (cpu.trace.length > 1200) cpu.trace.shift();
    if (w.halt) cpu.halted = true;
    if (w.note) cpu.lastError = w.note;
  }

  const PREFIX_BYTES = new Set([0xF0, 0xF2, 0xF3, 0x26, 0x2E, 0x36, 0x3E]);

  function microStep(cpu) {
    if (cpu.halted) return;
    try {
      switch (cpu.stage) {
        case 'FETCH': {
          cpu.pending = { startIP: cpu.regs.IP, prefixes: [] };
          let b = cpu.memory[cpu.regs.IP], guard = 0;
          while (PREFIX_BYTES.has(b) && guard++ < 6) {
            cpu.pending.prefixes.push(b);
            cpu.regs.IP = (cpu.regs.IP + 1) & 0xFFFF;
            b = cpu.memory[cpu.regs.IP];
          }
          cpu.pending.opcode = b;
          cpu.regs.IP = (cpu.regs.IP + 1) & 0xFFFF;
          cpu.stage = 'DECODE';
          break;
        }
        case 'DECODE': {
          const dec = decodeOpcode(cpu.pending.opcode);
          dec.prefixes = cpu.pending.prefixes;
          dec.rep = cpu.pending.prefixes.includes(0xF2) ? 'REPNE' : cpu.pending.prefixes.includes(0xF3) ? 'REP' : null;
          cpu.pending.decoded = dec;
          cpu.stage = 'OPERAND_FETCH';
          break;
        }
        case 'OPERAND_FETCH': fetchOperands(cpu); cpu.stage = 'EXECUTE'; break;
        case 'EXECUTE': execute(cpu); cpu.stage = 'WRITEBACK'; break;
        case 'WRITEBACK': writeback(cpu); cpu.stage = cpu.halted ? 'HALTED' : 'FETCH'; break;
      }
    } catch (e) {
      cpu.lastError = e.message;
      cpu.halted = true;
      cpu.stage = 'HALTED';
    }
  }

  function stepInstruction(cpu) {
    if (cpu.halted) return;
    let guard = 0;
    do { microStep(cpu); } while (!cpu.halted && cpu.stage !== 'FETCH' && guard++ < 20);
  }

  // ---- disassembly (for the execution trace) ----
  function disasmText(d) {
    const r = (code, w) => w ? REG16_NAMES[code] : REG8_NAMES[code];
    const rmText = (m) => {
      if (!m) return '?';
      if (!m.isMem) return r(m.rm, m.w);
      return `[${hex4(m.addr)}H]`;
    };
    const pfx = d.rep === 'REP' ? 'REP ' : d.rep === 'REPNE' ? 'REPNE ' : '';
    switch (d.family) {
      case 'MOV_RI': return `MOV ${r(d.reg, d.w)},${d.w ? hex4(d.imm) : hex2(d.imm)}H`;
      case 'MOV_RM': return d.dir === 'toReg' ? `MOV ${r(d.rm.reg, d.rm.w)},${rmText(d.rm)}` : `MOV ${rmText(d.rm)},${r(d.rm.reg, d.rm.w)}`;
      case 'MOV_MI': return `MOV ${rmText(d.rm)},${d.w ? hex4(d.imm) : hex2(d.imm)}H`;
      case 'MOV_SR': return d.dir === 'toSreg' ? `MOV ${SREG_NAMES[d.rm.reg]},${rmText(d.rm)}` : `MOV ${rmText(d.rm)},${SREG_NAMES[d.rm.reg]}`;
      case 'LEA': return `LEA ${REG16_NAMES[d.rm.reg]},[${hex4(d.rm.addr)}H]`;
      case 'ARITH_RM': return d.dir === 'toReg' ? `${d.op} ${r(d.rm.reg, d.rm.w)},${rmText(d.rm)}` : `${d.op} ${rmText(d.rm)},${r(d.rm.reg, d.rm.w)}`;
      case 'ARITH_MI': return `${d.op} ${rmText(d.rm)},${d.w ? hex4(d.imm & 0xFFFF) : hex2(d.imm)}H`;
      case 'ARITH_AI': return `${d.op} ${d.w ? 'AX' : 'AL'},${d.w ? hex4(d.imm) : hex2(d.imm)}H`;
      case 'TEST_RM': return `TEST ${r(d.rm.reg, d.rm.w)},${rmText(d.rm)}`;
      case 'TEST_AI': return `TEST ${d.w ? 'AX' : 'AL'},${d.w ? hex4(d.imm) : hex2(d.imm)}H`;
      case 'XCHG_RM': return `XCHG ${rmText(d.rm)},${r(d.rm.reg, d.rm.w)}`;
      case 'XCHG_AX': return `XCHG AX,${REG16_NAMES[d.reg]}`;
      case 'INCDEC_R': return `${d.delta > 0 ? 'INC' : 'DEC'} ${REG16_NAMES[d.reg]}`;
      case 'GRP_FE': case 'GRP_FF': {
        const t = ['INC', 'DEC', 'CALL', 'CALLF', 'JMP', 'JMPF', 'PUSH', '?'][d.rm.reg];
        return `${t} ${rmText(d.rm)}`;
      }
      case 'GRP3': return `${GRP3_NAME[d.rm.reg]} ${rmText(d.rm)}${d.rm.reg < 2 ? ',' + (d.w ? hex4(d.imm) : hex2(d.imm)) + 'H' : ''}`;
      case 'SHIFT': return `${d.sub} ${rmText(d.rm)},${d.countKind === 'CL' ? 'CL' : d.countKind === 'imm8' ? d.count : '1'}`;
      case 'PUSH_R': return `PUSH ${REG16_NAMES[d.reg]}`;
      case 'POP_R': return `POP ${REG16_NAMES[d.reg]}`;
      case 'PUSH_I': return `PUSH ${hex4(d.imm)}H`;
      case 'PUSHF': return 'PUSHF'; case 'POPF': return 'POPF';
      case 'PUSHA': return 'PUSHA'; case 'POPA': return 'POPA';
      case 'PUSH_SR': return `PUSH ${SREG_NAMES[d.sreg]}`;
      case 'POP_SR': return `POP ${SREG_NAMES[d.sreg]}`;
      case 'JMP_D': return `JMP ${hex4(d.targetAddr)}H`;
      case 'CALL_D': return `CALL ${hex4(d.targetAddr)}H`;
      case 'RET': return d.far ? 'RETF' : 'RET';
      case 'IRET': return 'IRET';
      case 'JCC': return `${d.cond} ${hex4(d.targetAddr)}H`;
      case 'JCXZ': return `JCXZ ${hex4(d.targetAddr)}H`;
      case 'LOOP': return `${d.kind} ${hex4(d.targetAddr)}H`;
      case 'INT': return d.n3 ? 'INT 3' : `INT ${hex2(d.n)}H`;
      case 'INTO': return 'INTO';
      case 'CBW': return 'CBW'; case 'CWD': return 'CWD'; case 'XLAT': return 'XLAT';
      case 'BCDADJ': return d.kind;
      case 'ASCADJ': return d.kind;
      case 'STRING': return `${pfx}${d.sop}${d.w ? 'W' : 'B'}`;
      case 'FLAGOP': return { 0xF8: 'CLC', 0xF9: 'STC', 0xF5: 'CMC', 0xFC: 'CLD', 0xFD: 'STD', 0xFA: 'CLI', 0xFB: 'STI' }[d.op];
      case 'IN': return `IN ${d.w ? 'AX' : 'AL'},${d.imm ? hex2(d.port) + 'H' : 'DX'}`;
      case 'OUT': return `OUT ${d.imm ? hex2(d.port) + 'H' : 'DX'},${d.w ? 'AX' : 'AL'}`;
      case 'NOP': return 'NOP'; case 'HLT': return 'HLT';
      case 'UNKNOWN': return `DB ${hex2(d.op)}H`;
      default: return d.family || '???';
    }
  }

  return {
    name: '8086', REG16, REG16_NAMES, REG8, REG8_NAMES, SREG, SREG_NAMES, REGISTER_NAMES, MNEMONICS, DIRECTIVES,
    encode, disasmText, createCPU, microStep, stepInstruction,
    STAGES: ['FETCH', 'DECODE', 'OPERAND_FETCH', 'EXECUTE', 'WRITEBACK'],
    regList16: ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP'],
    regList8: [],
    segList: ['DS', 'ES', 'SS', 'CS'],
    flagList: ['CF', 'PF', 'AF', 'ZF', 'SF', 'OF', 'DF', 'IF'],
    branchRelax: { promotable: new Set(Object.keys(JCC_OPC)), shortSize: 2, longSize: 5 },
  };
})();
