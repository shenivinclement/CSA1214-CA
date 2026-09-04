// Headless assemble-and-execute driver.
//
// This is the piece the REST API is built on, but it has no HTTP in it - the
// browser calls the very same function to produce a local result it can compare
// against the server's. Everything it returns is plain JSON-serialisable data.
'use strict';

import { assemble } from './assembler.js';
import { CPU8085 } from './cpu8085.js';
import { CPU8086 } from './cpu8086.js';
import { hex2, hex4 } from './common.js';

export const LIMITS = {
  MAX_SOURCE_BYTES: 128 * 1024,
  MAX_INSTRUCTIONS: 5000000,
  DEFAULT_INSTRUCTIONS: 1000000,
  MAX_WALL_MS: 5000,
  MAX_TRACE: 500,
  MAX_MEMORY_RANGES: 8,
  MAX_RANGE_BYTES: 4096,
};

export function engineFor(arch) {
  if (arch === '8086') return CPU8086;
  if (arch === '8085') return CPU8085;
  throw new Error(`Unknown architecture '${arch}' (expected '8085' or '8086')`);
}

/** Normalises + validates the shared request shape. Throws Error on bad input. */
export function validateRequest(body) {
  const source = typeof body?.source === 'string' ? body.source : null;
  if (source === null) throw new Error("Field 'source' is required and must be a string of assembly text");
  if (source.length > LIMITS.MAX_SOURCE_BYTES) throw new Error(`Source is too large (${source.length} bytes, limit ${LIMITS.MAX_SOURCE_BYTES})`);

  const arch = body.arch === undefined || body.arch === null ? '8085' : String(body.arch);
  if (arch !== '8085' && arch !== '8086') throw new Error(`Field 'arch' must be '8085' or '8086' (got ${JSON.stringify(body.arch)})`);

  let maxInstructions = body.maxInstructions === undefined ? LIMITS.DEFAULT_INSTRUCTIONS : Number(body.maxInstructions);
  if (!Number.isFinite(maxInstructions) || maxInstructions < 1) throw new Error("Field 'maxInstructions' must be a positive number");
  maxInstructions = Math.min(Math.floor(maxInstructions), LIMITS.MAX_INSTRUCTIONS);

  const ranges = normaliseRanges(body.memory);
  return { source, arch, maxInstructions, ranges };
}

function normaliseRanges(memory) {
  if (memory === undefined || memory === null) return [];
  if (!Array.isArray(memory)) throw new Error("Field 'memory' must be an array of { start, length } ranges");
  if (memory.length > LIMITS.MAX_MEMORY_RANGES) throw new Error(`At most ${LIMITS.MAX_MEMORY_RANGES} memory ranges may be requested`);
  return memory.map((r, i) => {
    const start = Number(r?.start);
    const length = Number(r?.length ?? 16);
    if (!Number.isFinite(start) || start < 0 || start > 0xFFFF) throw new Error(`memory[${i}].start must be 0..65535`);
    if (!Number.isFinite(length) || length < 1 || length > LIMITS.MAX_RANGE_BYTES) throw new Error(`memory[${i}].length must be 1..${LIMITS.MAX_RANGE_BYTES}`);
    return { start: Math.floor(start), length: Math.floor(length) };
  });
}

/** Assembles only. Returns the listing, symbol table and machine code. */
export function assembleProgram({ source, arch }) {
  const started = Date.now();
  const result = assemble(source, arch);
  const listing = result.listing.map(e => ({
    line: e.lineNo,
    address: e.bytes && e.bytes.length ? e.address : null,
    addressHex: e.bytes && e.bytes.length ? hex4(e.address) : null,
    bytes: e.bytes || [],
    bytesHex: (e.bytes || []).map(hex2).join(' '),
    label: e.label || null,
    mnemonic: e.mnemonic || null,
    operands: e.operands || [],
    directive: e.directive || null,
  }));
  const symbols = {};
  for (const [name, value] of result.symtab) symbols[name] = { value, hex: hex4(value) };

  let code = [];
  if (result.minAddr !== null && result.maxAddr !== null) {
    code = Array.from(result.memory.slice(result.minAddr, result.maxAddr + 1));
  }

  return {
    ok: result.success,
    arch,
    errors: result.errors.map(e => ({ line: e.lineNo, message: e.message })),
    listing,
    symbols,
    byteCount: listing.reduce((n, e) => n + e.bytes.length, 0),
    origin: result.minAddr,
    originHex: result.minAddr === null ? null : hex4(result.minAddr),
    endAddress: result.maxAddr,
    startAddress: result.startAddress,
    startAddressHex: hex4(result.startAddress),
    hex: code.map(hex2).join(' '),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Assembles then executes to HLT (or until a limit is hit).
 * Never throws for a program fault - a faulting program comes back with
 * ok:true, halted:true and a `fault` string, because that is a normal result
 * for a trainer.
 */
export function runProgram({ source, arch, maxInstructions = LIMITS.DEFAULT_INSTRUCTIONS, ranges = [] }) {
  const asm = assembleProgram({ source, arch });
  if (!asm.ok) return { ok: false, stage: 'assemble', assembly: asm };

  const mod = engineFor(arch);
  const result = assemble(source, arch);        // fresh memory image for execution
  const cpu = mod.createCPU(result.memory);
  if (arch === '8086') cpu.regs.IP = result.startAddress; else cpu.regs.PC = result.startAddress;

  const started = Date.now();
  const deadline = started + LIMITS.MAX_WALL_MS;
  let instructions = 0;
  let stopReason = 'halted';

  while (!cpu.halted) {
    if (instructions >= maxInstructions) { stopReason = 'instruction-limit'; break; }
    if ((instructions & 0x3FFF) === 0 && Date.now() > deadline) { stopReason = 'time-limit'; break; }
    mod.stepInstruction(cpu);
    instructions++;
  }

  const registers = {};
  for (const name of Object.keys(cpu.regs)) {
    const wide = arch === '8086' || name === 'SP' || name === 'PC';
    registers[name] = { value: cpu.regs[name], hex: wide ? hex4(cpu.regs[name]) : hex2(cpu.regs[name]) };
  }

  const memory = ranges.map(r => ({
    start: r.start,
    startHex: hex4(r.start),
    length: r.length,
    bytes: Array.from({ length: r.length }, (_, k) => cpu.memory[(r.start + k) & 0xFFFF]),
    hex: Array.from({ length: r.length }, (_, k) => hex2(cpu.memory[(r.start + k) & 0xFFFF])).join(' '),
  }));

  return {
    ok: true,
    stage: 'run',
    arch,
    assembly: asm,
    halted: cpu.halted,
    stopReason,
    fault: cpu.lastError || null,
    instructions,
    cycles: cpu.cycles,
    registers,
    flags: { ...cpu.flags },
    console: arch === '8086' ? (cpu.consoleText || '') : '',
    portWrites: cpu.outputLog.filter(o => o.port !== undefined).map(o => ({ port: o.port, portHex: hex4(o.port), value: o.value, valueHex: hex2(o.value) })),
    trace: cpu.trace.slice(-LIMITS.MAX_TRACE).map(t => ({ address: t.pc, addressHex: hex4(t.pc), bytes: t.bytes.map(hex2).join(' '), text: t.text })),
    memory,
    elapsedMs: Date.now() - started,
  };
}
