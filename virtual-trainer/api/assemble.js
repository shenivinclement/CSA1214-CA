// POST /api/assemble
//
// Body: { "source": "<assembly text>", "arch": "8085" | "8086" }
// Returns the two-pass assembler's output: address/byte listing, symbol table,
// machine code as hex, and per-line error messages.
//
// Runs the exact same core/assembler.js that the browser UI uses.
'use strict';

import { assembleProgram, validateRequest } from '../public/core/runner.js';
import { route, send, fail } from './_lib.js';

export default route(['POST'], async (req, res, body) => {
  let input;
  try { input = validateRequest(body); }
  catch (e) { return fail(res, 400, e.message); }

  const result = assembleProgram({ source: input.source, arch: input.arch });
  return send(res, result.ok ? 200 : 422, result);
});
