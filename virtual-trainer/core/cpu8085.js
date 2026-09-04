// Module 1 (encoder half) + Module 2 (CPU execution engine) for the 8085.
// Everything about the 8085 instruction set lives in this one file: the text->bytes
// encoder used by the assembler, and the bytes->behaviour decoder/executor used by
// the CPU engine. Both share the same register/condition-code tables so they can
// never drift out of sync with each other.
'use strict';

import { hex2, hex4, parity8 } from './common.js';
import { resolveOperand } from './expr.js';

export const CPU8085 = (function () {
  const REG8 = { B: 0, C: 1, D: 2, E: 3, H: 4, L: 5, M: 6, A: 7 };
  const REG8_NAMES = ['B', 'C', 'D', 'E', 'H', 'L', 'M', 'A'];
  const RP = { B: 0, D: 1, H: 2, SP: 3 };
  const RP_NAMES = ['B', 'D', 'H', 'SP'];
  const RP_PSW = { B: 0, D: 1, H: 2, PSW: 3 };
  const RP_PSW_NAMES = ['B', 'D', 'H', 'PSW'];
  const COND = { NZ: 0, Z: 1, NC: 2, C: 3, PO: 4, PE: 5, P: 6, M: 7 };
  const COND_NAMES = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
  const ALU_R_NAMES = ['ADD', 'ADC', 'SUB', 'SBB', 'ANA', 'XRA', 'ORA', 'CMP'];
  const ALU_IMM_NAMES = ['ADI', 'ACI', 'SUI', 'SBI', 'ANI', 'XRI', 'ORI', 'CPI'];
  const ALU_OP_OF = { ADD: 'ADD', ADI: 'ADD', ADC: 'ADC', ACI: 'ADC', SUB: 'SUB', SUI: 'SUB', SBB: 'SBB', SBI: 'SBB', ANA: 'AND', ANI: 'AND', XRA: 'XOR', XRI: 'XOR', ORA: 'OR', ORI: 'OR', CMP: 'CMP', CPI: 'CMP' };
  const SINGLE_BYTE_OPS = { NOP: 0x00, HLT: 0x76, RLC: 0x07, RRC: 0x0F, RAL: 0x17, RAR: 0x1F, DAA: 0x27, CMA: 0x2F, STC: 0x37, CMC: 0x3F, XCHG: 0xEB, XTHL: 0xE3, SPHL: 0xF9, PCHL: 0xE9, DI: 0xF3, EI: 0xFB, RIM: 0x20, SIM: 0x30, RET: 0xC9 };

  const REGISTER_NAMES = new Set(['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'SP', 'PSW']);
  const MNEMONICS = new Set([...Object.keys(SINGLE_BYTE_OPS), ...ALU_R_NAMES, ...ALU_IMM_NAMES,
    'MOV', 'MVI', 'INR', 'DCR', 'INX', 'DCX', 'DAD', 'LXI', 'STAX', 'LDAX', 'PUSH', 'POP',
    'LDA', 'STA', 'LHLD', 'SHLD', 'IN', 'OUT', 'JMP', 'CALL', 'RST',
    ...COND_NAMES.map(c => 'J' + c), ...COND_NAMES.map(c => 'C' + c), ...COND_NAMES.map(c => 'R' + c)]);
  const DIRECTIVES = new Set(['ORG', 'END', 'DB', 'DW', 'EQU']);

  // ---- Encoder: assembly text -> bytes (used by the two-pass assembler) ----
  function requireOperands(mnemonic, operands, n) {
    if (operands.length !== n) throw new Error(`${mnemonic} expects ${n} operand${n === 1 ? '' : 's'}, got ${operands.length}`);
  }
  function reg(mnemonic, tok) {
    const code = REG8[tok];
    if (code === undefined) throw new Error(`${mnemonic}: '${tok}' is not a valid 8085 register (B,C,D,E,H,L,M,A)`);
    return code;
  }
  function rp(mnemonic, tok) {
    const code = RP[tok];
    if (code === undefined) throw new Error(`${mnemonic}: '${tok}' is not a valid register pair (B,D,H,SP)`);
    return code;
  }
  function rpPsw(mnemonic, tok) {
    const code = RP_PSW[tok];
    if (code === undefined) throw new Error(`${mnemonic}: '${tok}' is not a valid register pair (B,D,H,PSW)`);
    return code;
  }
  function num(tok, ctx) { return resolveOperand(tok, ctx) & 0xFF; }
  function addr16(tok, ctx) { const v = resolveOperand(tok, ctx) & 0xFFFF; return [v & 0xFF, (v >> 8) & 0xFF]; }

  function encode(mnemonic, operands, ctx) {
    if (mnemonic in SINGLE_BYTE_OPS) { requireOperands(mnemonic, operands, 0); return [SINGLE_BYTE_OPS[mnemonic]]; }

    if (mnemonic === 'MOV') {
      requireOperands(mnemonic, operands, 2);
      const d = reg(mnemonic, operands[0]), s = reg(mnemonic, operands[1]);
      if (d === 6 && s === 6) throw new Error('MOV M,M is not a valid instruction (that opcode is reserved for HLT)');
      return [0x40 | (d << 3) | s];
    }
    if (mnemonic === 'MVI') { requireOperands(mnemonic, operands, 2); const d = reg(mnemonic, operands[0]); return [0x06 | (d << 3), num(operands[1], ctx)]; }
    if (ALU_R_NAMES.includes(mnemonic)) {
      requireOperands(mnemonic, operands, 1);
      const idx = ALU_R_NAMES.indexOf(mnemonic); const s = reg(mnemonic, operands[0]);
      return [0x80 | (idx << 3) | s];
    }
    if (ALU_IMM_NAMES.includes(mnemonic)) { requireOperands(mnemonic, operands, 1); const idx = ALU_IMM_NAMES.indexOf(mnemonic); return [0xC6 | (idx << 3), num(operands[0], ctx)]; }
    if (mnemonic === 'INR') { requireOperands(mnemonic, operands, 1); return [0x04 | (reg(mnemonic, operands[0]) << 3)]; }
    if (mnemonic === 'DCR') { requireOperands(mnemonic, operands, 1); return [0x05 | (reg(mnemonic, operands[0]) << 3)]; }
    if (mnemonic === 'INX') { requireOperands(mnemonic, operands, 1); return [0x03 | (rp(mnemonic, operands[0]) << 4)]; }
    if (mnemonic === 'DCX') { requireOperands(mnemonic, operands, 1); return [0x0B | (rp(mnemonic, operands[0]) << 4)]; }
    if (mnemonic === 'DAD') { requireOperands(mnemonic, operands, 1); return [0x09 | (rp(mnemonic, operands[0]) << 4)]; }
    if (mnemonic === 'LXI') { requireOperands(mnemonic, operands, 2); const r = rp(mnemonic, operands[0]); const v = resolveOperand(operands[1], ctx) & 0xFFFF; return [0x01 | (r << 4), v & 0xFF, (v >> 8) & 0xFF]; }
    if (mnemonic === 'STAX') { requireOperands(mnemonic, operands, 1); const r = rp(mnemonic, operands[0]); if (r > 1) throw new Error('STAX only supports register pair B or D'); return [0x02 | (r << 4)]; }
    if (mnemonic === 'LDAX') { requireOperands(mnemonic, operands, 1); const r = rp(mnemonic, operands[0]); if (r > 1) throw new Error('LDAX only supports register pair B or D'); return [0x0A | (r << 4)]; }
    if (mnemonic === 'PUSH') { requireOperands(mnemonic, operands, 1); return [0xC5 | (rpPsw(mnemonic, operands[0]) << 4)]; }
    if (mnemonic === 'POP') { requireOperands(mnemonic, operands, 1); return [0xC1 | (rpPsw(mnemonic, operands[0]) << 4)]; }
    if (mnemonic === 'LDA') { requireOperands(mnemonic, operands, 1); return [0x3A, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'STA') { requireOperands(mnemonic, operands, 1); return [0x32, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'LHLD') { requireOperands(mnemonic, operands, 1); return [0x2A, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'SHLD') { requireOperands(mnemonic, operands, 1); return [0x22, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'IN') { requireOperands(mnemonic, operands, 1); return [0xDB, num(operands[0], ctx)]; }
    if (mnemonic === 'OUT') { requireOperands(mnemonic, operands, 1); return [0xD3, num(operands[0], ctx)]; }
    if (mnemonic === 'JMP') { requireOperands(mnemonic, operands, 1); return [0xC3, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'CALL') { requireOperands(mnemonic, operands, 1); return [0xCD, ...addr16(operands[0], ctx)]; }
    if (mnemonic === 'RST') { requireOperands(mnemonic, operands, 1); const n = resolveOperand(operands[0], ctx); if (n < 0 || n > 7) throw new Error('RST operand must be 0-7'); return [0xC7 | (n << 3)]; }
    if (mnemonic[0] === 'J' && COND_NAMES.includes(mnemonic.slice(1))) { requireOperands(mnemonic, operands, 1); return [0xC2 | (COND[mnemonic.slice(1)] << 3), ...addr16(operands[0], ctx)]; }
    if (mnemonic[0] === 'C' && COND_NAMES.includes(mnemonic.slice(1))) { requireOperands(mnemonic, operands, 1); return [0xC4 | (COND[mnemonic.slice(1)] << 3), ...addr16(operands[0], ctx)]; }
    if (mnemonic[0] === 'R' && COND_NAMES.includes(mnemonic.slice(1))) { requireOperands(mnemonic, operands, 0); return [0xC0 | (COND[mnemonic.slice(1)] << 3)]; }

    throw new Error(`Unknown 8085 mnemonic '${mnemonic}'`);
  }

  // ---- Decode table: bytes -> instruction descriptor (single source of truth, generated) ----
  function buildDecodeTable() {
    const table = new Array(256).fill(null);
    function set(op, entry) {
      op &= 0xFF;
      if (table[op]) throw new Error('Internal error: 8085 opcode collision at ' + hex2(op));
      table[op] = entry;
    }
    for (const [name, op] of Object.entries(SINGLE_BYTE_OPS)) set(op, { mnemonic: name, family: name, bytes: 1 });
    for (let d = 0; d < 8; d++) for (let s = 0; s < 8; s++) {
      if (d === 6 && s === 6) continue; // HLT
      set(0x40 | (d << 3) | s, { mnemonic: 'MOV', family: 'MOV', d, s, bytes: 1 });
    }
    ALU_R_NAMES.forEach((name, idx) => { for (let s = 0; s < 8; s++) set(0x80 | (idx << 3) | s, { mnemonic: name, family: 'ALU_R', s, bytes: 1 }); });
    ALU_IMM_NAMES.forEach((name, idx) => set(0xC6 | (idx << 3), { mnemonic: name, family: 'ALU_IMM', bytes: 2 }));
    for (let d = 0; d < 8; d++) {
      set(0x06 | (d << 3), { mnemonic: 'MVI', family: 'MVI', d, bytes: 2 });
      set(0x04 | (d << 3), { mnemonic: 'INR', family: 'INR', d, bytes: 1 });
      set(0x05 | (d << 3), { mnemonic: 'DCR', family: 'DCR', d, bytes: 1 });
    }
    for (let r = 0; r < 4; r++) {
      set(0x03 | (r << 4), { mnemonic: 'INX', family: 'INX', rp: r, bytes: 1 });
      set(0x0B | (r << 4), { mnemonic: 'DCX', family: 'DCX', rp: r, bytes: 1 });
      set(0x09 | (r << 4), { mnemonic: 'DAD', family: 'DAD', rp: r, bytes: 1 });
      set(0x01 | (r << 4), { mnemonic: 'LXI', family: 'LXI', rp: r, bytes: 3 });
      set(0xC5 | (r << 4), { mnemonic: 'PUSH', family: 'PUSH', rp: r, bytes: 1 });
      set(0xC1 | (r << 4), { mnemonic: 'POP', family: 'POP', rp: r, bytes: 1 });
    }
    for (let r = 0; r < 2; r++) {
      set(0x02 | (r << 4), { mnemonic: 'STAX', family: 'STAX', rp: r, bytes: 1 });
      set(0x0A | (r << 4), { mnemonic: 'LDAX', family: 'LDAX', rp: r, bytes: 1 });
    }
    set(0x3A, { mnemonic: 'LDA', family: 'LDA', bytes: 3 });
    set(0x32, { mnemonic: 'STA', family: 'STA', bytes: 3 });
    set(0x2A, { mnemonic: 'LHLD', family: 'LHLD', bytes: 3 });
    set(0x22, { mnemonic: 'SHLD', family: 'SHLD', bytes: 3 });
    set(0xDB, { mnemonic: 'IN', family: 'IN', bytes: 2 });
    set(0xD3, { mnemonic: 'OUT', family: 'OUT', bytes: 2 });
    set(0xC3, { mnemonic: 'JMP', family: 'JMP', bytes: 3 });
    set(0xCD, { mnemonic: 'CALL', family: 'CALL', bytes: 3 });
    for (let c = 0; c < 8; c++) {
      set(0xC2 | (c << 3), { mnemonic: 'J' + COND_NAMES[c], family: 'JCOND', cond: c, bytes: 3 });
      set(0xC4 | (c << 3), { mnemonic: 'C' + COND_NAMES[c], family: 'CCOND', cond: c, bytes: 3 });
      set(0xC0 | (c << 3), { mnemonic: 'R' + COND_NAMES[c], family: 'RCOND', cond: c, bytes: 1 });
      set(0xC7 | (c << 3), { mnemonic: 'RST', family: 'RST', n: c, bytes: 1 });
    }
    return table;
  }
  const DECODE_TABLE = buildDecodeTable();

  function disasmText(d) {
    switch (d.family) {
      case 'MOV': return `MOV ${REG8_NAMES[d.d]},${REG8_NAMES[d.s]}`;
      case 'MVI': return `MVI ${REG8_NAMES[d.d]},${hex2(d.imm8)}H`;
      case 'ALU_R': return `${d.mnemonic} ${REG8_NAMES[d.s]}`;
      case 'ALU_IMM': return `${d.mnemonic} ${hex2(d.imm8)}H`;
      case 'INR': return `INR ${REG8_NAMES[d.d]}`;
      case 'DCR': return `DCR ${REG8_NAMES[d.d]}`;
      case 'INX': return `INX ${RP_NAMES[d.rp]}`;
      case 'DCX': return `DCX ${RP_NAMES[d.rp]}`;
      case 'DAD': return `DAD ${RP_NAMES[d.rp]}`;
      case 'LXI': return `LXI ${RP_NAMES[d.rp]},${hex4(d.imm16)}H`;
      case 'STAX': return `STAX ${RP_NAMES[d.rp]}`;
      case 'LDAX': return `LDAX ${RP_NAMES[d.rp]}`;
      case 'PUSH': return `PUSH ${RP_PSW_NAMES[d.rp]}`;
      case 'POP': return `POP ${RP_PSW_NAMES[d.rp]}`;
      case 'LDA': return `LDA ${hex4(d.addr16)}H`;
      case 'STA': return `STA ${hex4(d.addr16)}H`;
      case 'LHLD': return `LHLD ${hex4(d.addr16)}H`;
      case 'SHLD': return `SHLD ${hex4(d.addr16)}H`;
      case 'IN': return `IN ${hex2(d.port)}H`;
      case 'OUT': return `OUT ${hex2(d.port)}H`;
      case 'JMP': return `JMP ${hex4(d.addr16)}H`;
      case 'JCOND': return `${d.mnemonic} ${hex4(d.addr16)}H`;
      case 'CALL': return `CALL ${hex4(d.addr16)}H`;
      case 'CCOND': return `${d.mnemonic} ${hex4(d.addr16)}H`;
      case 'RST': return `RST ${d.n}`;
      case null: default: return d.mnemonic || '???';
    }
  }

  // ---- CPU engine: 5-stage FSM (Fetch, Decode, Operand Fetch, Execute, Writeback) ----
  function createCPU(memory) {
    return {
      arch: '8085',
      regs: { A: 0, B: 0, C: 0, D: 0, E: 0, H: 0, L: 0, SP: 0xFFFF, PC: 0 },
      flags: { S: 0, Z: 0, AC: 0, P: 0, CY: 0 },
      memory,
      interruptsEnabled: false,
      halted: false,
      stage: 'FETCH',
      pending: {},
      cycles: 0,
      io: new Uint8Array(256),
      outputLog: [],
      trace: [],
      lastError: null,
    };
  }

  function getReg8(cpu, code) { return code === 6 ? cpu.memory[(cpu.regs.H << 8) | cpu.regs.L] : cpu.regs[REG8_NAMES[code]]; }
  function rpGet(cpu, code) {
    const R = cpu.regs;
    if (code === 0) return (R.B << 8) | R.C;
    if (code === 1) return (R.D << 8) | R.E;
    if (code === 2) return (R.H << 8) | R.L;
    return R.SP;
  }
  function packFlags(F) { return (F.S << 7) | (F.Z << 6) | (F.AC << 4) | (F.P << 2) | (1 << 1) | F.CY; }
  function unpackFlags(b) { return { S: (b >> 7) & 1, Z: (b >> 6) & 1, AC: (b >> 4) & 1, P: (b >> 2) & 1, CY: b & 1 }; }
  function flagsSZP(result) { return { S: (result & 0x80) ? 1 : 0, Z: (result & 0xFF) === 0 ? 1 : 0, P: parity8(result) }; }
  function condTrue(cond, F) {
    switch (cond) { case 0: return !F.Z; case 1: return !!F.Z; case 2: return !F.CY; case 3: return !!F.CY; case 4: return !F.P; case 5: return !!F.P; case 6: return !F.S; case 7: return !!F.S; }
  }

  function aluOp(mnemonic, b, R, F, writes) {
    const a = R.A, op = ALU_OP_OF[mnemonic];
    let result, cy = F.CY, ac = F.AC;
    switch (op) {
      case 'ADD': { const sum = a + b; result = sum & 0xFF; cy = sum > 0xFF ? 1 : 0; ac = ((a & 0xF) + (b & 0xF)) > 0xF ? 1 : 0; break; }
      case 'ADC': { const cin = F.CY, sum = a + b + cin; result = sum & 0xFF; cy = sum > 0xFF ? 1 : 0; ac = ((a & 0xF) + (b & 0xF) + cin) > 0xF ? 1 : 0; break; }
      case 'SUB': { const diff = a - b; result = diff & 0xFF; cy = diff < 0 ? 1 : 0; ac = ((a & 0xF) - (b & 0xF)) < 0 ? 1 : 0; break; }
      case 'SBB': { const bin = F.CY, diff = a - b - bin; result = diff & 0xFF; cy = diff < 0 ? 1 : 0; ac = ((a & 0xF) - (b & 0xF) - bin) < 0 ? 1 : 0; break; }
      case 'AND': result = a & b; cy = 0; ac = ((a | b) & 0x08) ? 1 : 0; break;
      case 'XOR': result = a ^ b; cy = 0; ac = 0; break;
      case 'OR': result = a | b; cy = 0; ac = 0; break;
      case 'CMP': { const diff = a - b; result = diff & 0xFF; cy = diff < 0 ? 1 : 0; ac = ((a & 0xF) - (b & 0xF)) < 0 ? 1 : 0; break; }
    }
    const f = flagsSZP(result);
    writes.flags = { S: f.S, Z: f.Z, P: f.P, AC: ac, CY: cy };
    if (op !== 'CMP') writes.regs.A = result;
  }

  function fetchOperands(cpu) {
    const d = cpu.pending.decoded, mem = cpu.memory;
    let pc = cpu.regs.PC;
    const u8 = () => { const v = mem[pc]; pc = (pc + 1) & 0xFFFF; return v; };
    const u16 = () => { const lo = u8(), hi = u8(); return (hi << 8) | lo; };
    switch (d.family) {
      case 'MVI': case 'ALU_IMM': d.imm8 = u8(); break;
      case 'LXI': d.imm16 = u16(); break;
      case 'LDA': case 'STA': case 'LHLD': case 'SHLD': case 'JMP': case 'JCOND': case 'CALL': case 'CCOND': d.addr16 = u16(); break;
      case 'IN': case 'OUT': d.port = u8(); break;
    }
    cpu.regs.PC = pc;
    switch (d.family) {
      case 'MOV': d.srcVal = getReg8(cpu, d.s); break;
      case 'ALU_R': d.srcVal = getReg8(cpu, d.s); break;
      case 'INR': case 'DCR': d.curVal = getReg8(cpu, d.d); break;
    }
  }

  function execute(cpu) {
    const d = cpu.pending.decoded, R = cpu.regs, F = cpu.flags;
    const writes = { regs: {}, mem: {}, flags: {} };
    cpu.pending.writes = writes;
    function setReg(code, val) { val &= 0xFF; if (code === 6) writes.mem[(R.H << 8) | R.L] = val; else writes.regs[REG8_NAMES[code]] = val; }
    function rpSet(code, val) {
      val &= 0xFFFF;
      if (code === 0) { writes.regs.B = (val >> 8) & 0xFF; writes.regs.C = val & 0xFF; }
      else if (code === 1) { writes.regs.D = (val >> 8) & 0xFF; writes.regs.E = val & 0xFF; }
      else if (code === 2) { writes.regs.H = (val >> 8) & 0xFF; writes.regs.L = val & 0xFF; }
      else writes.sp = val;
    }
    switch (d.family) {
      case 'NOP': break;
      case 'HLT': writes.halt = true; break;
      case 'MOV': setReg(d.d, d.srcVal); break;
      case 'MVI': setReg(d.d, d.imm8); break;
      case 'ALU_R': aluOp(d.mnemonic, d.srcVal, R, F, writes); break;
      case 'ALU_IMM': aluOp(d.mnemonic, d.imm8, R, F, writes); break;
      case 'INR': { const v = (d.curVal + 1) & 0xFF; setReg(d.d, v); const f = flagsSZP(v); writes.flags = { S: f.S, Z: f.Z, P: f.P, AC: (d.curVal & 0x0F) === 0x0F ? 1 : 0 }; break; }
      case 'DCR': { const v = (d.curVal - 1) & 0xFF; setReg(d.d, v); const f = flagsSZP(v); writes.flags = { S: f.S, Z: f.Z, P: f.P, AC: (d.curVal & 0x0F) !== 0 ? 1 : 0 }; break; }
      case 'INX': rpSet(d.rp, (rpGet(cpu, d.rp) + 1) & 0xFFFF); break;
      case 'DCX': rpSet(d.rp, (rpGet(cpu, d.rp) - 1) & 0xFFFF); break;
      case 'DAD': { const sum = rpGet(cpu, 2) + rpGet(cpu, d.rp); writes.flags = { CY: sum > 0xFFFF ? 1 : 0 }; rpSet(2, sum & 0xFFFF); break; }
      case 'LXI': rpSet(d.rp, d.imm16); break;
      case 'STAX': writes.mem[rpGet(cpu, d.rp)] = R.A; break;
      case 'LDAX': writes.regs.A = cpu.memory[rpGet(cpu, d.rp)]; break;
      case 'PUSH': {
        let hi, lo;
        if (d.rp === 3) { hi = R.A; lo = packFlags(F); } else { const v = rpGet(cpu, d.rp); hi = (v >> 8) & 0xFF; lo = v & 0xFF; }
        const sp = R.SP; writes.mem[(sp - 1) & 0xFFFF] = hi; writes.mem[(sp - 2) & 0xFFFF] = lo; writes.sp = (sp - 2) & 0xFFFF; break;
      }
      case 'POP': {
        const sp = R.SP, lo = cpu.memory[sp], hi = cpu.memory[(sp + 1) & 0xFFFF];
        if (d.rp === 3) { writes.regs.A = hi; writes.flags = unpackFlags(lo); } else { rpSet(d.rp, (hi << 8) | lo); }
        writes.sp = (sp + 2) & 0xFFFF; break;
      }
      case 'LDA': writes.regs.A = cpu.memory[d.addr16]; break;
      case 'STA': writes.mem[d.addr16] = R.A; break;
      case 'LHLD': writes.regs.L = cpu.memory[d.addr16]; writes.regs.H = cpu.memory[(d.addr16 + 1) & 0xFFFF]; break;
      case 'SHLD': writes.mem[d.addr16] = R.L; writes.mem[(d.addr16 + 1) & 0xFFFF] = R.H; break;
      case 'IN': writes.regs.A = cpu.io[d.port]; break;
      case 'OUT': writes.ioOut = { port: d.port, value: R.A }; break;
      case 'JMP': writes.pc = d.addr16; break;
      case 'JCOND': if (condTrue(d.cond, F)) writes.pc = d.addr16; break;
      case 'CALL': { const ret = R.PC, sp = R.SP; writes.mem[(sp - 1) & 0xFFFF] = (ret >> 8) & 0xFF; writes.mem[(sp - 2) & 0xFFFF] = ret & 0xFF; writes.sp = (sp - 2) & 0xFFFF; writes.pc = d.addr16; break; }
      case 'CCOND': if (condTrue(d.cond, F)) { const ret = R.PC, sp = R.SP; writes.mem[(sp - 1) & 0xFFFF] = (ret >> 8) & 0xFF; writes.mem[(sp - 2) & 0xFFFF] = ret & 0xFF; writes.sp = (sp - 2) & 0xFFFF; writes.pc = d.addr16; } break;
      case 'RET': { const sp = R.SP, lo = cpu.memory[sp], hi = cpu.memory[(sp + 1) & 0xFFFF]; writes.pc = (hi << 8) | lo; writes.sp = (sp + 2) & 0xFFFF; break; }
      case 'RCOND': if (condTrue(d.cond, F)) { const sp = R.SP, lo = cpu.memory[sp], hi = cpu.memory[(sp + 1) & 0xFFFF]; writes.pc = (hi << 8) | lo; writes.sp = (sp + 2) & 0xFFFF; } break;
      case 'RST': { const ret = R.PC, sp = R.SP; writes.mem[(sp - 1) & 0xFFFF] = (ret >> 8) & 0xFF; writes.mem[(sp - 2) & 0xFFFF] = ret & 0xFF; writes.sp = (sp - 2) & 0xFFFF; writes.pc = d.n * 8; break; }
      case 'RLC': { const a = R.A, cy = (a & 0x80) ? 1 : 0; writes.regs.A = ((a << 1) | cy) & 0xFF; writes.flags = { CY: cy }; break; }
      case 'RRC': { const a = R.A, cy = a & 1; writes.regs.A = ((a >> 1) | (cy << 7)) & 0xFF; writes.flags = { CY: cy }; break; }
      case 'RAL': { const a = R.A, ncy = (a & 0x80) ? 1 : 0; writes.regs.A = ((a << 1) | F.CY) & 0xFF; writes.flags = { CY: ncy }; break; }
      case 'RAR': { const a = R.A, ncy = a & 1; writes.regs.A = ((a >> 1) | (F.CY << 7)) & 0xFF; writes.flags = { CY: ncy }; break; }
      case 'CMA': writes.regs.A = (~R.A) & 0xFF; break;
      case 'STC': writes.flags = { CY: 1 }; break;
      case 'CMC': writes.flags = { CY: F.CY ? 0 : 1 }; break;
      case 'DAA': {
        const a = R.A; let cy = F.CY, corr = 0; const lo = a & 0xF, hi = (a >> 4) & 0xF;
        if (lo > 9 || F.AC) corr += 0x06;
        if (hi > 9 || cy || (hi >= 9 && lo > 9)) { corr += 0x60; cy = 1; }
        const ac = ((a & 0xF) + (corr & 0xF)) > 0xF ? 1 : 0;
        const result = (a + corr) & 0xFF;
        const f = flagsSZP(result);
        writes.regs.A = result; writes.flags = { S: f.S, Z: f.Z, P: f.P, AC: ac, CY: cy };
        break;
      }
      case 'XCHG': writes.regs.H = R.D; writes.regs.L = R.E; writes.regs.D = R.H; writes.regs.E = R.L; break;
      case 'XTHL': { const sp = R.SP, lo = cpu.memory[sp], hi = cpu.memory[(sp + 1) & 0xFFFF]; writes.mem[sp] = R.L; writes.mem[(sp + 1) & 0xFFFF] = R.H; writes.regs.L = lo; writes.regs.H = hi; break; }
      case 'SPHL': writes.sp = rpGet(cpu, 2); break;
      case 'PCHL': writes.pc = rpGet(cpu, 2); break;
      case 'DI': writes.interruptsEnabled = false; break;
      case 'EI': writes.interruptsEnabled = true; break;
      case 'RIM': writes.regs.A = 0; break;
      case 'SIM': break;
      default: break;
    }
  }

  function writeback(cpu) {
    const w = cpu.pending.writes, d = cpu.pending.decoded;
    Object.assign(cpu.regs, w.regs);
    for (const addrStr in w.mem) cpu.memory[addrStr & 0xFFFF] = w.mem[addrStr] & 0xFF;
    Object.assign(cpu.flags, w.flags);
    if (w.sp !== undefined) cpu.regs.SP = w.sp;
    if (w.pc !== undefined) cpu.regs.PC = w.pc;
    if (w.interruptsEnabled !== undefined) cpu.interruptsEnabled = w.interruptsEnabled;
    if (w.ioOut) { cpu.io[w.ioOut.port] = w.ioOut.value; cpu.outputLog.push({ port: w.ioOut.port, value: w.ioOut.value, cycle: cpu.cycles }); }
    cpu.cycles++;
    const bytes = [];
    for (let i = 0; i < d.bytes; i++) bytes.push(cpu.memory[(cpu.pending.startPC + i) & 0xFFFF]);
    cpu.trace.push({ pc: cpu.pending.startPC, bytes, text: disasmText(d) });
    if (cpu.trace.length > 1000) cpu.trace.shift();
    if (w.halt) cpu.halted = true;
  }

  function microStep(cpu) {
    if (cpu.halted) return;
    try {
      switch (cpu.stage) {
        case 'FETCH':
          cpu.pending = { startPC: cpu.regs.PC };
          cpu.pending.opcode = cpu.memory[cpu.regs.PC];
          cpu.regs.PC = (cpu.regs.PC + 1) & 0xFFFF;
          cpu.stage = 'DECODE';
          break;
        case 'DECODE':
          cpu.pending.decoded = { ...(DECODE_TABLE[cpu.pending.opcode] || { mnemonic: '???', family: 'UNKNOWN', bytes: 1 }) };
          cpu.stage = 'OPERAND_FETCH';
          break;
        case 'OPERAND_FETCH':
          fetchOperands(cpu);
          cpu.stage = 'EXECUTE';
          break;
        case 'EXECUTE':
          execute(cpu);
          cpu.stage = 'WRITEBACK';
          break;
        case 'WRITEBACK':
          writeback(cpu);
          cpu.stage = cpu.halted ? 'HALTED' : 'FETCH';
          break;
      }
    } catch (e) {
      cpu.lastError = e.message;
      cpu.halted = true;
      cpu.stage = 'HALTED';
    }
  }

  function stepInstruction(cpu) {
    if (cpu.halted) return;
    do { microStep(cpu); } while (!cpu.halted && cpu.stage !== 'FETCH');
  }

  return {
    name: '8085', REG8, REG8_NAMES, RP, RP_NAMES, RP_PSW, RP_PSW_NAMES, COND, COND_NAMES,
    REGISTER_NAMES, MNEMONICS, DIRECTIVES,
    encode, disasmText, createCPU, microStep, stepInstruction,
    STAGES: ['FETCH', 'DECODE', 'OPERAND_FETCH', 'EXECUTE', 'WRITEBACK'],
    regList16: [], regList8: ['A', 'B', 'C', 'D', 'E', 'H', 'L'],
    flagList: ['S', 'Z', 'AC', 'P', 'CY'],
  };
})();
