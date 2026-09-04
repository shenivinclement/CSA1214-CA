// API tests: boot the real dev server, then drive the real HTTP endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39085;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('dev server did not start in time');
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
});

after(() => { if (child) child.kill(); });

const post = (route, body) => fetch(BASE + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('GET /api/health passes its own self-test', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.selfTest.passed, true);
  assert.ok(j.architectures['8086'].mnemonics > 50, 'expected a broad 8086 mnemonic set');
});

test('POST /api/assemble returns listing, symbols and machine code', async () => {
  const res = await post('/api/assemble', { source: 'ORG 100H\nSTART: MOV AX,1234H\nHLT', arch: '8086' });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.hex, 'B8 34 12 F4');
  assert.equal(j.symbols.START.hex, '0100');
  assert.equal(j.byteCount, 4);
});

test('POST /api/assemble reports per-line errors with 422', async () => {
  const res = await post('/api/assemble', { source: 'ORG 100H\nBLARG AX\nHLT', arch: '8086' });
  const j = await res.json();
  assert.equal(res.status, 422);
  assert.equal(j.ok, false);
  assert.equal(j.errors[0].line, 2);
  assert.match(j.errors[0].message, /Unknown/);
});

test('POST /api/run executes to HLT and dumps requested memory', async () => {
  const res = await post('/api/run', {
    source: 'ORG 100H\nMOV AX,1234H\nMOV BX,4321H\nADD AX,BX\nMOV [3000H],AX\nHLT',
    arch: '8086',
    memory: [{ start: 0x3000, length: 2 }],
  });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.halted, true);
  assert.equal(j.registers.AX.hex, '5555');
  assert.equal(j.memory[0].hex, '55 55');
  assert.equal(j.instructions, 5);
});

test('POST /api/run captures INT 21H console output', async () => {
  const res = await post('/api/run', { source: 'ORG 100H\nMOV DX,M\nMOV AH,9\nINT 21H\nMOV AH,4CH\nINT 21H\nM: DB "OK$"', arch: '8086' });
  const j = await res.json();
  assert.equal(j.console, 'OK');
});

test('POST /api/run reports a runtime fault without failing the request', async () => {
  const res = await post('/api/run', { source: 'ORG 100H\nMOV AX,10\nMOV BL,0\nDIV BL\nHLT', arch: '8086' });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.match(j.fault, /division by zero/i);
});

test('POST /api/run stops an infinite loop at the instruction limit', async () => {
  const res = await post('/api/run', { source: 'ORG 2000H\nL: JMP L', arch: '8085', maxInstructions: 5000 });
  const j = await res.json();
  assert.equal(j.halted, false);
  assert.equal(j.stopReason, 'instruction-limit');
  assert.equal(j.instructions, 5000);
});

test('bad input is rejected with 400 and a readable message', async () => {
  const noSource = await (await post('/api/run', { arch: '8086' })).json();
  assert.match(noSource.error, /'source' is required/);

  const badArch = await (await post('/api/run', { source: 'HLT', arch: 'z80' })).json();
  assert.match(badArch.error, /must be '8085' or '8086'/);

  const badRange = await (await post('/api/run', { source: 'HLT', memory: [{ start: 99999, length: 4 }] })).json();
  assert.match(badRange.error, /start must be 0\.\.65535/);
});

test('wrong method and malformed JSON are handled cleanly', async () => {
  const res = await fetch(`${BASE}/api/run`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');

  const bad = await fetch(`${BASE}/api/assemble`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /parse request body/);
});

test('CORS preflight is answered', async () => {
  const res = await fetch(`${BASE}/api/run`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('static frontend and core modules are served', async () => {
  const html = await fetch(`${BASE}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Virtual Trainer/);

  const core = await fetch(`${BASE}/core/cpu8086.js`);
  assert.equal(core.status, 200);
  assert.match(core.headers.get('content-type'), /javascript/);
});

test('coursework documents are not reachable over HTTP', async () => {
  for (const p of ['/Shen%20Ivin%20Clement%20192371023_Capstone_Report.docx', '/package.json', '/../package.json']) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 404, `${p} should not be served`);
  }
});
