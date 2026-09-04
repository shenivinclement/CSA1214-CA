// Barrel module for the isomorphic trainer core.
//
// The browser UI (js/ui.js) and the serverless API (api/*.js) both import from
// here, so there is exactly one assembler and one implementation of each CPU -
// no duplicated instruction tables that could drift apart.
export { hex2, hex4, bin8, parity8, clamp, escapeHtml, CpuRuntimeError } from './common.js';
export { parseNumLit, parseNumber, evalExpr, resolveOperand } from './expr.js';
export { assemble, parseLine, splitOperands } from './assembler.js';
export { CPU8085 } from './cpu8085.js';
export { CPU8086 } from './cpu8086.js';
export { EXAMPLES } from './examples.js';
export { runProgram, assembleProgram, validateRequest, engineFor, LIMITS } from './runner.js';

export const CORE_VERSION = '2.0.0';
