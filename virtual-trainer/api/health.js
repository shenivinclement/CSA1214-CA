// GET /api/health
//
// Liveness probe plus a machine-readable description of what this deployment
// supports - handy for a demo, and it proves the serverless function really is
// executing the shared core rather than returning a canned string.
'use strict';

import { CORE_VERSION } from '../core/index.js';
import { CPU8085 } from '../core/cpu8085.js';
import { CPU8086 } from '../core/cpu8086.js';
import { LIMITS, runProgram } from '../core/runner.js';
import { route, send } from './_lib.js';

// A tiny program executed on every health check: 05H + 03H must equal 08H.
const SELF_TEST = 'ORG 2000H\nMVI A,05H\nMVI B,03H\nADD B\nSTA 2050H\nHLT';

export default route(['GET'], async (req, res) => {
  const probe = runProgram({ source: SELF_TEST, arch: '8085', ranges: [{ start: 0x2050, length: 1 }] });
  const selfTestPassed = probe.ok && probe.halted && probe.memory[0].bytes[0] === 8;

  return send(res, selfTestPassed ? 200 : 503, {
    ok: selfTestPassed,
    service: '8085/8086 Virtual Trainer API',
    coreVersion: CORE_VERSION,
    runtime: `node ${process.version}`,
    selfTest: { program: 'MVI A,05H / MVI B,03H / ADD B', expected: 8, got: probe.memory?.[0]?.bytes?.[0] ?? null, passed: selfTestPassed },
    architectures: {
      '8085': { mnemonics: CPU8085.MNEMONICS.size, stages: CPU8085.STAGES, flags: CPU8085.flagList },
      '8086': { mnemonics: CPU8086.MNEMONICS.size, stages: CPU8086.STAGES, flags: CPU8086.flagList },
    },
    endpoints: [
      { method: 'POST', path: '/api/assemble', body: { source: 'string', arch: '8085|8086' } },
      { method: 'POST', path: '/api/run', body: { source: 'string', arch: '8085|8086', maxInstructions: 'number?', memory: '[{start,length}]?' } },
      { method: 'GET', path: '/api/health' },
    ],
    limits: LIMITS,
  });
});
