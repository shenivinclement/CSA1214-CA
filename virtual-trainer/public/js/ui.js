// Module 3: Web UI & Debugger.
// Wires the editor, toolbar, and all panels to the assembler (Module 1) and the
// CPU engine (Module 2). Nothing about instruction semantics lives here - this
// file only renders state and dispatches user actions.
//
// Everything below the import line is browser-only. The engine itself lives in
// /core and is byte-for-byte the same code the /api serverless functions run.
'use strict';

import { CPU8085 } from '../core/cpu8085.js';
import { CPU8086 } from '../core/cpu8086.js';
import { assemble } from '../core/assembler.js';
import { runProgram } from '../core/runner.js';
import { hex2, hex4, escapeHtml } from '../core/common.js';

const state = {
  arch: '8085',
  mod: CPU8085,
  cpu: null,
  asmResult: null,
  addrToLine: new Map(),
  pristineMemory: null,
  breakpoints: new Set(),
  running: false,
  rafId: null,
  runTimer: null,
  skipBreakpointOnce: false,
  totalRunInstr: 0,
  memBase: 0,
  changedRegs: new Set(),
  api: { online: null, info: null },
  server: null,        // last /api/run response, plus the local comparison
  serverBusy: false,
};

let codeEditor, highlightLayer, gutter, lineHighlight;
let btnAssemble, btnStepInstr, btnMicroStep, btnRun, btnPause, btnReset, speedSlider, statusLine, archSelect;
let btnServerRun, btnClear, apiBadge;

// Your program is kept per-architecture and saved as you type, so switching
// between 8085 and 8086 never throws away what you wrote, and a refresh or an
// accidental tab close does not lose it either.
const STORE_KEY = arch => `trainer.source.${arch}`;
const PLACEHOLDER = {
  '8085': '; Type your 8085 program here, then press Assemble.',
  '8086': '; Type your 8086 program here, then press Assemble.',
};

function loadSource(arch) {
  try { return localStorage.getItem(STORE_KEY(arch)) ?? ''; }
  catch { return ''; }
}
function saveSource(arch, text) {
  try { localStorage.setItem(STORE_KEY(arch), text); } catch { /* private mode - not fatal */ }
}

const LINE_H = 20;

document.addEventListener('DOMContentLoaded', () => {
  codeEditor = document.getElementById('codeEditor');
  highlightLayer = document.getElementById('highlightLayer');
  gutter = document.getElementById('gutter');
  lineHighlight = document.getElementById('lineHighlight');
  btnAssemble = document.getElementById('btnAssemble');
  btnStepInstr = document.getElementById('btnStepInstr');
  btnMicroStep = document.getElementById('btnMicroStep');
  btnRun = document.getElementById('btnRun');
  btnPause = document.getElementById('btnPause');
  btnReset = document.getElementById('btnReset');
  btnServerRun = document.getElementById('btnServerRun');
  apiBadge = document.getElementById('apiBadge');
  speedSlider = document.getElementById('speedSlider');
  statusLine = document.getElementById('statusLine');
  archSelect = document.getElementById('archSelect');
  btnClear = document.getElementById('btnClear');

  codeEditor.addEventListener('input', () => {
    saveSource(state.arch, codeEditor.value);
    renderHighlight();
    renderGutter();
  });
  codeEditor.addEventListener('scroll', () => {
    highlightLayer.scrollTop = codeEditor.scrollTop;
    highlightLayer.scrollLeft = codeEditor.scrollLeft;
    gutter.scrollTop = codeEditor.scrollTop;
    updateCurrentLineUI();
  });
  codeEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = codeEditor.selectionStart, end = codeEditor.selectionEnd;
      codeEditor.value = codeEditor.value.slice(0, start) + '        ' + codeEditor.value.slice(end);
      codeEditor.selectionStart = codeEditor.selectionEnd = start + 8;
      renderHighlight(); renderGutter();
    }
  });

  archSelect.addEventListener('change', () => {
    saveSource(state.arch, codeEditor.value);   // keep the program you were writing
    state.arch = archSelect.value;
    onArchChange();
  });
  btnClear.addEventListener('click', clearEditor);

  btnAssemble.addEventListener('click', assembleProgram);
  btnStepInstr.addEventListener('click', doStepInstruction);
  btnMicroStep.addEventListener('click', doMicroStep);
  btnRun.addEventListener('click', startRun);
  btnPause.addEventListener('click', stopRun);
  btnReset.addEventListener('click', doReset);
  btnServerRun.addEventListener('click', runOnServer);

  document.getElementById('memGo').addEventListener('click', () => {
    const v = parseInt(document.getElementById('memAddrInput').value.replace(/H$/i, ''), 16);
    if (!isNaN(v)) { state.memBase = v & 0xFFFF; renderMemory(); }
  });
  document.getElementById('memPrev').addEventListener('click', () => { state.memBase = (state.memBase - 0x100) & 0xFFFF; document.getElementById('memAddrInput').value = hex4(state.memBase); renderMemory(); });
  document.getElementById('memNext').addEventListener('click', () => { state.memBase = (state.memBase + 0x100) & 0xFFFF; document.getElementById('memAddrInput').value = hex4(state.memBase); renderMemory(); });

  document.getElementById('listingTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr && tr.dataset.line) jumpToLine(Number(tr.dataset.line));
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      const group = btn.closest('.panel');
      group.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      group.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
    });
  });

  onArchChange();
  renderServerPanel();
  checkApiHealth();
});

function switchTab(tabId) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

// ---------------- Architecture ----------------

function onArchChange() {
  stopRun();
  state.mod = state.arch === '8086' ? CPU8086 : CPU8085;
  document.getElementById('archBadge').textContent = state.arch;
  state.cpu = null;
  state.asmResult = null;
  state.breakpoints = new Set();
  state.memBase = 0;
  // Each architecture keeps its own program; nothing you typed is discarded.
  codeEditor.value = loadSource(state.arch);
  renderHighlight();
  renderGutter();
  renderHelp();
  assembleProgram();
}

function clearEditor() {
  stopRun();
  codeEditor.value = '';
  saveSource(state.arch, '');
  state.breakpoints = new Set();
  renderHighlight();
  renderGutter();
  assembleProgram();
  codeEditor.focus();
}

// ---------------- Editor: syntax highlight, gutter, breakpoints ----------------

function highlightLine(line, mod) {
  const commentIdx = line.indexOf(';');
  const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const comment = commentIdx >= 0 ? line.slice(commentIdx) : '';
  let html = '';
  let rest = code;
  let firstWord = true;
  const mLabel = code.match(/^(\s*)([A-Za-z_]\w*)(\s*:)(.*)$/);
  if (mLabel) { html += escapeHtml(mLabel[1]) + `<span class="tok-label">${escapeHtml(mLabel[2])}</span>` + escapeHtml(mLabel[3]); rest = mLabel[4]; }
  const re = /(\s+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_]\w*)|(\d[0-9A-Za-z]*)|(.)/g;
  let match;
  while ((match = re.exec(rest))) {
    const [, ws, str, word, num] = match;
    if (ws) { html += ws; continue; }
    if (str) { html += `<span class="tok-string">${escapeHtml(str)}</span>`; continue; }
    if (word) {
      const up = word.toUpperCase();
      if (firstWord) { html += `<span class="tok-mnemonic">${escapeHtml(word)}</span>`; }
      else if (mod.REGISTER_NAMES.has(up)) html += `<span class="tok-register">${escapeHtml(word)}</span>`;
      else if (mod.DIRECTIVES.has(up)) html += `<span class="tok-directive">${escapeHtml(word)}</span>`;
      else html += `<span class="tok-symbol">${escapeHtml(word)}</span>`;
      firstWord = false;
      continue;
    }
    if (num) { html += `<span class="tok-number">${escapeHtml(num)}</span>`; firstWord = false; continue; }
    html += escapeHtml(match[0]);
    if (match[0].trim()) firstWord = false;
  }
  if (comment) html += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
  return html || ' ';
}

function renderHighlight() {
  if (codeEditor.value === '') {
    // The textarea's own text is transparent, so the hint is drawn in the
    // highlight layer underneath it. It disappears the moment you type.
    highlightLayer.innerHTML = `<span class="tok-placeholder">${escapeHtml(PLACEHOLDER[state.arch])}</span>`;
    return;
  }
  const lines = codeEditor.value.split('\n');
  highlightLayer.innerHTML = lines.map(l => highlightLine(l, state.mod)).join('\n');
}

function renderGutter() {
  const lines = codeEditor.value.split('\n');
  gutter.innerHTML = lines.map((_, i) => {
    const lineNo = i + 1;
    const bp = state.breakpoints.has(lineNo) ? 'bp' : '';
    return `<div class="line ${bp}" data-line="${lineNo}">${lineNo}</div>`;
  }).join('');
  gutter.querySelectorAll('.line').forEach(el => el.addEventListener('click', () => toggleBreakpoint(Number(el.dataset.line))));
  gutter.scrollTop = codeEditor.scrollTop;
  markErrorLinesInGutter(state.asmResult);
}

function toggleBreakpoint(lineNo) {
  if (state.breakpoints.has(lineNo)) state.breakpoints.delete(lineNo); else state.breakpoints.add(lineNo);
  renderGutter();
}

function markErrorLinesInGutter(result) {
  document.querySelectorAll('#gutter .line').forEach(el => el.classList.remove('error-line'));
  if (!result || result.success) return;
  const errLines = new Set(result.errors.map(e => e.lineNo));
  document.querySelectorAll('#gutter .line').forEach(el => { if (errLines.has(Number(el.dataset.line))) el.classList.add('error-line'); });
}

function jumpToLine(lineNo) {
  const lines = codeEditor.value.split('\n');
  let pos = 0;
  for (let i = 0; i < lineNo - 1; i++) pos += lines[i].length + 1;
  codeEditor.focus();
  codeEditor.selectionStart = pos;
  codeEditor.selectionEnd = pos + (lines[lineNo - 1] ? lines[lineNo - 1].length : 0);
  codeEditor.scrollTop = Math.max(0, (lineNo - 4) * LINE_H);
  highlightLayer.scrollTop = codeEditor.scrollTop;
  gutter.scrollTop = codeEditor.scrollTop;
  updateCurrentLineUI();
}

// ---------------- Assemble ----------------

function countBytes(result) { return result.listing.reduce((n, e) => n + (e.bytes ? e.bytes.length : 0), 0); }

function assembleProgram() {
  stopRun();
  const result = assemble(codeEditor.value, state.arch);
  state.asmResult = result;
  state.addrToLine = new Map();
  for (const entry of result.listing) if (entry.bytes && entry.bytes.length > 0) state.addrToLine.set(entry.address, entry.lineNo);

  renderListing(result);
  renderErrors(result);
  markErrorLinesInGutter(result);

  if (result.success && countBytes(result) === 0) {
    // Nothing was emitted (blank editor, or only comments/directives). Don't
    // hand back a CPU that would just run NOPs through empty memory.
    state.cpu = null;
    state.pristineMemory = null;
    setStatus(codeEditor.value.trim() === ''
      ? 'Type a program in the editor, then press Assemble.'
      : 'Nothing to assemble - no instructions found.', 'info');
  } else if (result.success) {
    state.pristineMemory = result.memory.slice();
    state.cpu = state.mod.createCPU(result.memory);
    if (state.arch === '8086') state.cpu.regs.IP = result.startAddress; else state.cpu.regs.PC = result.startAddress;
    state.memBase = result.startAddress & 0xFFF0;
    document.getElementById('memAddrInput').value = hex4(state.memBase);
    setStatus(`Assembled OK - ${result.listing.filter(e => e.bytes && e.bytes.length > 0).length} lines, ${countBytes(result)} bytes.`, 'success');
  } else {
    state.cpu = null;
    setStatus(`${result.errors.length} error(s) - see the Errors tab.`, 'error');
    switchTab('tab-errors');
  }
  state.changedRegs = new Set();
  renderAll();
}

function renderListing(result) {
  const table = document.getElementById('listingTable');
  table.innerHTML = result.listing.map(entry => {
    const hasBytes = entry.bytes && entry.bytes.length > 0;
    const addr = hasBytes ? hex4(entry.address) + 'H' : '';
    const bytesStr = hasBytes ? entry.bytes.map(b => hex2(b)).join(' ') : (entry.directive || '');
    const src = `${entry.label ? entry.label + ': ' : ''}${entry.mnemonic || ''} ${(entry.operands || []).join(',')}`.trim();
    return `<tr data-line="${entry.lineNo}" data-addr="${hasBytes ? entry.address : ''}"><td class="addr">${addr}</td><td class="bytes">${bytesStr}</td><td class="src">${escapeHtml(src)}</td></tr>`;
  }).join('');
}

function renderErrors(result) {
  const body = document.getElementById('errorsBody');
  const countEl = document.getElementById('errCount');
  if (result.success) { body.innerHTML = '<span class="ok-msg">No errors. Assembly successful.</span>'; countEl.textContent = ''; return; }
  countEl.textContent = `(${result.errors.length})`;
  body.innerHTML = result.errors.map(e => `<div class="error-item" data-line="${e.lineNo}">Line ${e.lineNo}: ${escapeHtml(e.message)}</div>`).join('');
  body.querySelectorAll('.error-item').forEach(el => el.addEventListener('click', () => jumpToLine(Number(el.dataset.line))));
}

// ---------------- CPU control ----------------

function diffRegs(before, after) {
  const s = new Set();
  for (const k in after) if (before[k] !== after[k]) s.add(k);
  return s;
}

function doStepInstruction() {
  if (!state.cpu || state.cpu.halted) return;
  const before = { ...state.cpu.regs };
  state.mod.stepInstruction(state.cpu);
  state.changedRegs = diffRegs(before, state.cpu.regs);
  renderAll();
}

function doMicroStep() {
  if (!state.cpu || state.cpu.halted) return;
  const before = { ...state.cpu.regs };
  state.mod.microStep(state.cpu);
  state.changedRegs = diffRegs(before, state.cpu.regs);
  renderAll();
}

function doReset() {
  if (!state.asmResult || !state.asmResult.success || !state.cpu || !state.pristineMemory) return;
  stopRun();
  state.cpu.memory.set(state.pristineMemory);
  const mem = state.cpu.memory;
  state.cpu = state.mod.createCPU(mem);
  if (state.arch === '8086') state.cpu.regs.IP = state.asmResult.startAddress; else state.cpu.regs.PC = state.asmResult.startAddress;
  state.changedRegs = new Set();
  setStatus('Reset to start of program.', 'info');
  renderAll();
}

function scheduleRunTick() {
  // Prefer rAF for smoothness, but fall back to a timer if rAF is throttled
  // (background tab, embedded preview) so "Run" always makes progress.
  let fired = false;
  const go = () => { if (fired) return; fired = true; runLoop(); };
  state.rafId = requestAnimationFrame(go);
  state.runTimer = setTimeout(go, 16);
}

function startRun() {
  if (!state.cpu || state.cpu.halted) return;
  state.running = true;
  state.skipBreakpointOnce = true;
  state.totalRunInstr = 0;
  state.lastTick = performance.now();
  setStatus('Running...', 'running');
  updateRunButtons();
  scheduleRunTick();
}

function stopRun() {
  const wasRunning = state.running;
  state.running = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.runTimer) clearTimeout(state.runTimer);
  state.rafId = null;
  state.runTimer = null;
  updateRunButtons();
  if (wasRunning) renderAll();
}

function runLoop() {
  if (!state.running) return;
  const cpu = state.cpu, mod = state.mod;
  // "Speed" is a target instructions/frame; scale the batch by how much wall-clock
  // time actually elapsed, so a throttled timer (hidden tab, embedded preview)
  // still catches up instead of crawling. Hard-capped by a wall-clock budget so
  // the UI never freezes.
  const now = performance.now();
  const dt = Math.min(Math.max(now - (state.lastTick || now), 1), 500);
  state.lastTick = now;
  const perFrame = parseInt(speedSlider.value, 10);
  const budget = Math.min(200000, Math.max(perFrame, Math.round(perFrame * 60 * dt / 1000)));
  const deadline = now + 30;
  let done = 0;
  for (let i = 0; i < budget; i++) {
    if (!cpu || cpu.halted) { stopRun(); setStatus(cpu && cpu.lastError ? `Halted: ${cpu.lastError}` : 'Halted (HLT).', cpu && cpu.lastError ? 'error' : 'info'); break; }
    const pcAddr = state.arch === '8086' ? cpu.regs.IP : cpu.regs.PC;
    const lineNo = state.addrToLine.get(pcAddr);
    if (lineNo && state.breakpoints.has(lineNo) && !state.skipBreakpointOnce) {
      stopRun();
      setStatus(`Breakpoint hit at line ${lineNo}.`, 'info');
      break;
    }
    state.skipBreakpointOnce = false;
    mod.stepInstruction(cpu);
    state.totalRunInstr++;
    if (state.totalRunInstr > 5000000) { stopRun(); setStatus('Stopped after 5,000,000 instructions - check for a missing HLT or an infinite loop.', 'error'); break; }
    if (cpu.halted) { stopRun(); setStatus(cpu.lastError ? `Halted: ${cpu.lastError}` : 'Halted (HLT).', cpu.lastError ? 'error' : 'info'); break; }
    if ((++done & 4095) === 0 && performance.now() > deadline) break;
  }
  state.changedRegs = new Set();
  renderAll();
  if (state.running) scheduleRunTick();
}

function updateRunButtons() {
  const hasCpu = !!state.cpu;
  const halted = hasCpu && state.cpu.halted;
  btnAssemble.disabled = state.running;
  btnStepInstr.disabled = !hasCpu || halted || state.running;
  btnMicroStep.disabled = !hasCpu || halted || state.running;
  btnRun.disabled = !hasCpu || halted || state.running;
  btnPause.disabled = !state.running;
  btnReset.disabled = !hasCpu || !state.asmResult || !state.asmResult.success || state.running;
}

function setStatus(text, kind) {
  statusLine.textContent = text;
  statusLine.classList.remove('running', 'halted');
  if (kind === 'running') statusLine.classList.add('running');
  if (kind === 'error') statusLine.classList.add('halted');
}

// ---------------- Rendering ----------------

function renderAll() {
  renderRegs();
  renderFlags();
  renderFsm();
  renderMemory();
  renderTrace();
  renderConsole();
  updateCurrentLineUI();
  highlightCurrentListingRow();
  updateRunButtons();
}

function renderRegs() {
  const grid = document.getElementById('regGrid');
  const cpu = state.cpu;
  if (!cpu) { grid.innerHTML = '<span class="help-box">No program loaded. Click Assemble.</span>'; return; }
  const cells = [];
  if (state.arch === '8085') {
    for (const name of ['A', 'B', 'C', 'D', 'E', 'H', 'L']) cells.push({ name, val: hex2(cpu.regs[name]) });
    cells.push({ name: 'SP', val: hex4(cpu.regs.SP) });
    cells.push({ name: 'PC', val: hex4(cpu.regs.PC) });
  } else {
    for (const name of state.mod.regList16) cells.push({ name, val: hex4(cpu.regs[name]) });
    cells.push({ name: 'IP', val: hex4(cpu.regs.IP) });
    for (const name of (state.mod.segList || [])) cells.push({ name, val: hex4(cpu.regs[name] || 0) });
  }
  grid.innerHTML = cells.map(c => `<div class="reg-cell ${state.changedRegs.has(c.name) ? 'changed' : ''}"><div class="name">${c.name}</div><div class="val">${c.val}</div></div>`).join('');
}

function renderFlags() {
  const row = document.getElementById('flagRow');
  const cpu = state.cpu;
  if (!cpu) { row.innerHTML = ''; return; }
  row.innerHTML = state.mod.flagList.map(f => `<div class="flag-cell"><div class="flag-led ${cpu.flags[f] ? 'on' : ''}"></div><div class="name">${f}</div></div>`).join('');
}

const STAGE_LABELS = { FETCH: 'FETCH', DECODE: 'DECODE', OPERAND_FETCH: 'OPERAND FETCH', EXECUTE: 'EXECUTE', WRITEBACK: 'WRITE-BACK' };

function renderFsm() {
  const strip = document.getElementById('fsmStrip');
  const stages = state.mod.STAGES;
  let html = '';
  stages.forEach((s, i) => {
    if (i > 0) html += '<span class="fsm-arrow">&#9656;</span>';
    const active = state.cpu && !state.cpu.halted && state.cpu.stage === s;
    html += `<div class="fsm-stage ${active ? 'active' : ''}">${STAGE_LABELS[s]}</div>`;
  });
  strip.innerHTML = html;

  const detail = document.getElementById('fsmDetail');
  const cpu = state.cpu;
  if (!cpu) { detail.innerHTML = 'No program loaded.'; return; }
  const pcName = state.arch === '8086' ? 'IP' : 'PC';
  const pcVal = state.arch === '8086' ? cpu.regs.IP : cpu.regs.PC;
  if (cpu.halted) {
    detail.innerHTML = `<span class="halted">HALTED</span>${cpu.lastError ? ' - ' + escapeHtml(cpu.lastError) : ''} &middot; Cycles: ${cpu.cycles} &middot; ${pcName}=${hex4(pcVal)}H`;
  } else {
    detail.innerHTML = `<span class="running">Stage: ${STAGE_LABELS[cpu.stage]}</span> &middot; Cycles: ${cpu.cycles} &middot; ${pcName}=${hex4(pcVal)}H`;
  }
}

function renderMemory() {
  const table = document.getElementById('memTable');
  const cpu = state.cpu;
  if (!cpu) { table.innerHTML = ''; return; }
  const base = state.memBase & 0xFFF0;
  const pcAddr = state.arch === '8086' ? cpu.regs.IP : cpu.regs.PC;
  let rows = '';
  for (let r = 0; r < 16; r++) {
    const rowAddr = (base + r * 16) & 0xFFFF;
    let cells = '', ascii = '';
    for (let c = 0; c < 16; c++) {
      const addr = (rowAddr + c) & 0xFFFF;
      const v = cpu.memory[addr];
      cells += `<td class="byte ${v !== 0 ? 'nonzero' : ''} ${addr === pcAddr ? 'pc' : ''}">${hex2(v)}</td>`;
      ascii += (v >= 32 && v < 127) ? String.fromCharCode(v) : '.';
    }
    rows += `<tr><td class="addr">${hex4(rowAddr)}</td>${cells}<td class="ascii">${escapeHtml(ascii)}</td></tr>`;
  }
  table.innerHTML = rows;
}

function renderTrace() {
  const body = document.getElementById('traceBody');
  const cpu = state.cpu;
  if (!cpu) { body.innerHTML = ''; return; }
  body.innerHTML = cpu.trace.slice(-300).map(t => `<div class="trace-line"><span class="addr">${hex4(t.pc)}H</span><span class="txt">${escapeHtml(t.text)}</span></div>`).join('');
  body.scrollTop = body.scrollHeight;
}

function renderConsole() {
  const box = document.getElementById('consoleBox');
  const cpu = state.cpu;
  if (!cpu) { box.textContent = ''; return; }
  if (state.arch === '8086') {
    const io = cpu.outputLog.filter(o => o.port !== undefined).map(o => `OUT ${hex4(o.port)}H <- ${o.w ? hex4(o.value) : hex2(o.value)}H`);
    const parts = [];
    if (cpu.consoleText) parts.push(cpu.consoleText);
    if (io.length) parts.push(io.join('\n'));
    box.textContent = parts.length ? parts.join('\n') : '(no INT 21H / OUT output yet)';
  } else {
    box.textContent = cpu.outputLog.length ? cpu.outputLog.map(o => `OUT ${hex2(o.port)}H <- ${hex2(o.value)}H`).join('\n') : '(no OUT instructions executed yet)';
  }
}

function highlightCurrentListingRow() {
  const cpu = state.cpu;
  const rows = document.querySelectorAll('#listingTable tr');
  if (!cpu) { rows.forEach(tr => tr.classList.remove('current-row')); return; }
  const liveAddr = state.arch === '8086' ? cpu.regs.IP : cpu.regs.PC;
  const highlightAddr = cpu.stage === 'FETCH' ? liveAddr : (cpu.pending.startPC !== undefined ? cpu.pending.startPC : cpu.pending.startIP);
  rows.forEach(tr => tr.classList.toggle('current-row', tr.dataset.addr !== '' && Number(tr.dataset.addr) === highlightAddr));
}

function updateCurrentLineUI() {
  const cpu = state.cpu;
  document.querySelectorAll('#gutter .line').forEach(el => el.classList.remove('current'));
  if (!cpu) { lineHighlight.style.display = 'none'; return; }
  const liveAddr = state.arch === '8086' ? cpu.regs.IP : cpu.regs.PC;
  const highlightAddr = cpu.stage === 'FETCH' ? liveAddr : (cpu.pending.startPC !== undefined ? cpu.pending.startPC : cpu.pending.startIP);
  const lineNo = state.addrToLine.get(highlightAddr);
  if (lineNo === undefined) { lineHighlight.style.display = 'none'; return; }
  const idx = lineNo - 1;
  const gEl = document.querySelector(`#gutter .line[data-line="${lineNo}"]`);
  if (gEl) gEl.classList.add('current');
  lineHighlight.style.top = (idx * LINE_H - codeEditor.scrollTop) + 'px';
  lineHighlight.style.display = 'block';
}

// ---------------- Help ----------------

function renderHelp() {
  const body = document.getElementById('helpBody');
  if (state.arch === '8085') {
    body.innerHTML = `
      <h4>Directives</h4>
      <code>ORG addr</code> set location counter &middot; <code>DB v,v,"str"</code> define bytes &middot;
      <code>DW v,v</code> define words &middot; <code>LABEL EQU value</code> constant &middot; <code>END</code>
      <h4>Numbers &amp; expressions</h4>
      Decimal <code>25</code>, hex <code>19H</code> (leading digit required), binary <code>11001B</code>, octal <code>17O</code>, char <code>'A'</code>.
      Operands may be expressions: <code>LABEL+4</code>, <code>(COUNT*2)-1</code>, <code>-1</code>, <code>$</code> (current address),
      <code>+ - * / % &amp; | ^ &lt;&lt; &gt;&gt;</code>, <code>HIGH</code> / <code>LOW</code>.
      <h4>Registers</h4>
      A, B, C, D, E, H, L, M (memory via HL), register pairs B, D, H, SP (and PSW for PUSH/POP)
      <h4>Full 8085 instruction set implemented</h4>
      Data transfer: MOV, MVI, LXI, LDA, STA, LHLD, SHLD, LDAX, STAX, XCHG, SPHL, PCHL, PUSH, POP, XTHL, IN, OUT<br>
      Arithmetic: ADD, ADC, SUB, SBB, INR, DCR, INX, DCX, DAD, DAA, ADI, ACI, SUI, SBI<br>
      Logical: ANA, XRA, ORA, CMP, ANI, XRI, ORI, CPI, RLC, RRC, RAL, RAR, CMA, CMC, STC<br>
      Branch: JMP/Jcond, CALL/Ccond, RET/Rcond, RST 0-7, PCHL<br>
      Control: NOP, HLT, DI, EI, RIM, SIM
      <h4>Debugging</h4>
      Click a line number to toggle a breakpoint. "Micro-Step" advances one FSM stage
      (Fetch &rarr; Decode &rarr; Operand Fetch &rarr; Execute &rarr; Write-back) so you can see exactly
      when registers/flags/memory actually change. "Step Instruction" runs all five stages at once.
    `;
  } else {
    body.innerHTML = `
      <h4>Memory model</h4>
      One flat 64&nbsp;KB space. Segment registers (CS, DS, ES, SS) exist and can be
      loaded/stored, but do not translate addresses.
      <h4>Addressing modes</h4>
      Register, immediate, and the full ModRM set:
      <code>[BX]</code>, <code>[SI]</code>, <code>[DI]</code>, <code>[BP]</code>,
      <code>[BX+SI]</code>, <code>[BP+DI]</code>, <code>[BX+SI+4]</code>, <code>[LABEL+SI]</code>,
      direct <code>[1234H]</code>. Size with <code>BYTE PTR</code> / <code>WORD PTR</code> when it is ambiguous.
      <h4>Directives</h4>
      <code>ORG</code> &middot; <code>DB / DW</code> (with <code>10 DUP(0)</code>, <code>"str"</code>, <code>?</code>) &middot;
      <code>DS n</code> reserve bytes &middot; <code>LABEL EQU expr</code> &middot; <code>END</code>.
      Operands may be expressions: <code>+ - * / % &amp; | ^ &lt;&lt; &gt;&gt;</code>, <code>$</code>, <code>HIGH/LOW/OFFSET</code>.
      <h4>Registers</h4>
      16-bit: AX BX CX DX SI DI BP SP &middot; 8-bit: AL AH BL BH CL CH DL DH &middot; segment: CS DS ES SS
      <h4>Instructions</h4>
      <b>Data:</b> MOV, XCHG, LEA, XLAT, PUSH/POP (reg/mem/imm/seg), PUSHF/POPF, PUSHA/POPA, IN, OUT<br>
      <b>Arithmetic:</b> ADD ADC SUB SBB CMP INC DEC NEG MUL IMUL DIV IDIV, CBW, CWD<br>
      <b>Logic/shift:</b> AND OR XOR NOT TEST, SHL/SAL SHR SAR ROL ROR RCL RCR (by 1, CL, or count)<br>
      <b>Strings:</b> MOVSB/W, STOSB/W, LODSB/W, SCASB/W, CMPSB/W with REP / REPE / REPNE (DF via CLD/STD)<br>
      <b>Branch:</b> JMP (rel/reg/mem), CALL, RET/RETF, LOOP/LOOPE/LOOPNE, JCXZ, and every Jcc
      (JE/JZ, JNE/JNZ, JB/JC, JAE/JNC, JBE/JA, JL/JGE, JLE/JG, JS/JNS, JO/JNO, JP/JNP)<br>
      <b>Flags:</b> CLC STC CMC CLD STD CLI STI<br>
      <b>System:</b> INT (21H: AH=01/02/06/09 I/O, 4CH exit; 20H exit; 10H AH=0EH), NOP, HLT
      <h4>Long branches</h4>
      A conditional jump whose target is farther than &plusmn;127 bytes is assembled
      automatically as an inverted Jcc over a near <code>JMP</code> - so ordinary loops
      just work. (<code>LOOP</code> / <code>JCXZ</code> have no long form and still need a near target.)
    `;
  }
}

// ---------------- Backend (REST API) ----------------
// The trainer is fully functional offline - stepping, breakpoints and the FSM
// view always run in the browser. These calls exercise the serverless API,
// which executes the identical core/ engine, then diff the two results.

const API = { health: 'api/health', assemble: 'api/assemble', run: 'api/run' };

async function checkApiHealth() {
  setApiBadge('checking', 'API · checking');
  try {
    const res = await fetch(API.health, { headers: { accept: 'application/json' } });
    const info = await res.json();
    if (!res.ok || !info.ok) throw new Error(info.error || `HTTP ${res.status}`);
    state.api = { online: true, info };
    setApiBadge('online', `API · online`);
  } catch (e) {
    state.api = { online: false, info: null, error: String(e.message || e) };
    setApiBadge('offline', 'API · offline');
  }
  renderServerPanel();
}

function setApiBadge(kind, text) {
  if (!apiBadge) return;
  apiBadge.textContent = text;
  apiBadge.className = `api-badge ${kind}`;
}

// Memory ranges worth asking the server to dump back: the program image itself,
// plus any absolute address the program mentions as an operand.
function interestingRanges() {
  const out = [];
  const seen = new Set();
  const push = (start, length) => {
    start &= 0xFFF0;
    const key = `${start}:${length}`;
    if (seen.has(key) || out.length >= 8) return;
    seen.add(key);
    out.push({ start, length });
  };
  const r = state.asmResult;
  if (r && r.minAddr !== null) push(r.minAddr, Math.min(64, (r.maxAddr - r.minAddr) + 16));
  for (const entry of (r ? r.listing : [])) {
    for (const op of (entry.operands || [])) {
      const m = String(op).match(/^\[?\s*([0-9][0-9A-F]*H|\d+)\s*\]?$/i);
      if (!m) continue;
      const tok = m[1];
      const v = /H$/i.test(tok) ? parseInt(tok.slice(0, -1), 16) : parseInt(tok, 10);
      if (Number.isFinite(v) && v >= 0 && v <= 0xFFFF) push(v, 16);
    }
  }
  push(state.memBase, 16);
  return out.slice(0, 8);
}

async function runOnServer() {
  if (state.serverBusy) return;
  const source = codeEditor.value;
  const arch = state.arch;
  const ranges = interestingRanges();

  state.serverBusy = true;
  state.server = { pending: true, request: { arch, ranges, sourceBytes: source.length } };
  renderServerPanel();
  switchTab('tab-server');
  updateRunButtons();

  const started = performance.now();
  let payload = null, httpStatus = 0, transportError = null;
  try {
    const res = await fetch(API.run, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, arch, maxInstructions: 1000000, memory: ranges }),
    });
    httpStatus = res.status;
    payload = await res.json();
  } catch (e) {
    transportError = String(e.message || e);
  }
  const roundTripMs = Math.round(performance.now() - started);

  // Run the identical core locally so the two can be compared.
  let local = null, localError = null;
  try { local = runProgram({ source, arch, maxInstructions: 1000000, ranges }); }
  catch (e) { localError = String(e.message || e); }

  state.server = {
    pending: false, httpStatus, transportError, roundTripMs,
    request: { arch, ranges, sourceBytes: source.length },
    response: payload, local, localError,
    comparison: (payload && local) ? compareRuns(local, payload) : null,
  };
  state.serverBusy = false;
  if (!transportError) { state.api.online = true; setApiBadge('online', 'API · online'); }
  renderServerPanel();
  updateRunButtons();
}

// Diffs the browser result against the server result, field by field.
function compareRuns(local, remote) {
  const rows = [];
  const add = (name, a, b) => rows.push({ name, local: String(a), server: String(b), match: String(a) === String(b) });

  if (!remote.ok || !local.ok) {
    add('assembled', local.ok, remote.ok);
    return { rows, allMatch: local.ok === remote.ok };
  }
  add('halted', local.halted, remote.halted);
  add('stop reason', local.stopReason, remote.stopReason);
  add('instructions', local.instructions, remote.instructions);
  add('fault', local.fault || 'none', remote.fault || 'none');
  for (const name of Object.keys(local.registers)) add(name, local.registers[name].hex, remote.registers?.[name]?.hex ?? '—');
  for (const f of Object.keys(local.flags)) add(`flag ${f}`, local.flags[f], remote.flags?.[f] ?? '—');
  local.memory.forEach((m, i) => add(`mem ${m.startHex}H`, m.hex, remote.memory?.[i]?.hex ?? '—'));
  if (local.console || remote.console) add('console', JSON.stringify(local.console), JSON.stringify(remote.console));
  return { rows, allMatch: rows.every(r => r.match) };
}

function renderServerPanel() {
  const body = document.getElementById('serverBody');
  if (!body) return;
  const s = state.server;

  const health = state.api.online === null
    ? '<span class="srv-dim">Checking backend...</span>'
    : state.api.online
      ? `<span class="srv-ok">&#9679; Backend online</span> <span class="srv-dim">${escapeHtml(state.api.info?.runtime || '')} &middot; core ${escapeHtml(state.api.info?.coreVersion || '?')}</span>`
      : '<span class="srv-bad">&#9679; Backend unreachable</span> <span class="srv-dim">the trainer still works &mdash; everything runs in your browser</span>';

  if (!s) {
    body.innerHTML = `
      <div class="srv-head">${health}</div>
      <p class="srv-p">The assembler and both CPU engines live in <code>/core</code> and are imported by
      <b>both</b> this page and the serverless functions in <code>/api</code> &mdash; one engine, two runtimes.</p>
      <p class="srv-p">Press <b>&#9729; Run on Server</b> to assemble and execute this program on the backend,
      then diff the result against the browser engine.</p>
      <table class="srv-endpoints">
        <tr><td class="verb post">POST</td><td>/api/assemble</td><td class="srv-dim">listing, symbols, machine code</td></tr>
        <tr><td class="verb post">POST</td><td>/api/run</td><td class="srv-dim">headless execution to HLT</td></tr>
        <tr><td class="verb get">GET</td><td>/api/health</td><td class="srv-dim">status + self-test</td></tr>
      </table>`;
    return;
  }

  if (s.pending) {
    body.innerHTML = `<div class="srv-head">${health}</div><p class="srv-p">POST /api/run &mdash; waiting for the server...</p>`;
    return;
  }

  if (s.transportError) {
    body.innerHTML = `
      <div class="srv-head">${health}</div>
      <div class="srv-bad">Could not reach the API: ${escapeHtml(s.transportError)}</div>
      <p class="srv-p">If you opened <code>index.html</code> straight from disk there is no server to call.
      Run <code>npm run dev</code> and use <code>http://localhost:3000</code>, or open the deployed site.</p>`;
    return;
  }

  const r = s.response || {};
  let html = `<div class="srv-head">${health}</div>`;
  html += `<div class="srv-meta">POST <b>/api/run</b> &rarr; <b>${s.httpStatus}</b> &middot; round trip <b>${s.roundTripMs} ms</b> &middot; server compute <b>${r.elapsedMs ?? '?'} ms</b> &middot; arch <b>${escapeHtml(s.request.arch)}</b></div>`;

  if (r.ok === false && r.stage === 'assemble') {
    html += `<div class="srv-bad">Server rejected the program (${(r.assembly?.errors || []).length} assembly error(s)):</div><ul class="srv-errs">`;
    for (const e of (r.assembly?.errors || [])) html += `<li>Line ${e.line}: ${escapeHtml(e.message)}</li>`;
    html += '</ul>';
  } else if (r.ok) {
    html += `<div class="srv-meta">${r.halted ? 'Halted' : 'Stopped'} after <b>${r.instructions}</b> instruction(s) &mdash; ${escapeHtml(r.stopReason)}${r.fault ? ' &middot; fault: ' + escapeHtml(r.fault) : ''}</div>`;
    if (r.console) html += `<div class="srv-console">${escapeHtml(r.console)}</div>`;
    const cmp = s.comparison;
    if (cmp) {
      html += cmp.allMatch
        ? `<div class="srv-ok srv-verdict">&#10003; Server and browser agree on all ${cmp.rows.length} checked values</div>`
        : `<div class="srv-bad srv-verdict">&#10007; ${cmp.rows.filter(x => !x.match).length} of ${cmp.rows.length} values differ</div>`;
      html += '<table class="srv-table"><tr><th></th><th>Browser</th><th>Server</th></tr>';
      for (const row of cmp.rows) {
        html += `<tr class="${row.match ? '' : 'bad'}"><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.local)}</td><td>${escapeHtml(row.server)}</td></tr>`;
      }
      html += '</table>';
    }
  } else {
    html += `<div class="srv-bad">${escapeHtml(r.error || 'Unexpected response')}</div>`;
  }
  body.innerHTML = html;
}

// Debug/demo handle: lets you drive the trainer from the browser console.
window.trainer = { state, runOnServer, checkApiHealth, assemble, runProgram, CPU8085, CPU8086 };
