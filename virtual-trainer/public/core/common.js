// Shared formatting/bit helpers used by the assembler, both CPU engines, the
// web UI, and the serverless API. No DOM and no Node APIs - this module is
// deliberately isomorphic so the same build runs in a browser and on the server.
'use strict';

export function hex2(v) { return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
export function hex4(v) { return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
export function bin8(v) { return (v & 0xFF).toString(2).padStart(8, '0'); }

export function parity8(v) {
  v &= 0xFF;
  let bits = 0;
  for (let i = 0; i < 8; i++) if (v & (1 << i)) bits++;
  return (bits % 2 === 0) ? 1 : 0; // 1 = even parity (matches the 8085 P / 8086 PF convention)
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Thrown by a CPU engine for a fault the program itself caused (e.g. divide by zero). */
export class CpuRuntimeError extends Error {}
