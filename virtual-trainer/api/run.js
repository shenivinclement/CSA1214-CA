// POST /api/run
//
// Body: {
//   "source":          "<assembly text>",
//   "arch":            "8085" | "8086",         (default "8085")
//   "maxInstructions": 1000000,                  (optional, capped server-side)
//   "memory":          [ { "start": 8192, "length": 16 } ]   (optional dumps)
// }
//
// Assembles the program and executes it headlessly to HLT, then returns the
// final register file, flags, requested memory ranges, console output and the
// tail of the execution trace.
'use strict';

import { runProgram, validateRequest, LIMITS } from '../public/core/runner.js';
import { route, send, fail } from './_lib.js';

export default route(['POST'], async (req, res, body) => {
  let input;
  try { input = validateRequest(body); }
  catch (e) { return fail(res, 400, e.message, { limits: LIMITS }); }

  const result = runProgram(input);
  // A program that failed to assemble is a client-side problem (422); a program
  // that assembled and then faulted at runtime is a successful API call.
  return send(res, result.ok ? 200 : 422, result);
});
