// Engine correctness tests: assemble each program, execute it, assert on the
// resulting machine state.  Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgram, EXAMPLES } from '../public/core/index.js';

/** Assembles + runs `src`, asserting it reached HLT without a fault. */
function exec(arch, src, ranges = []) {
  const r = runProgram({ source: src, arch, ranges });
  assert.ok(r.ok, `assembly failed: ${JSON.stringify(r.assembly?.errors)}`);
  assert.equal(r.fault, null, `runtime fault: ${r.fault}`);
  assert.equal(r.halted, true, `did not halt (${r.stopReason})`);
  return r;
}
const byteAt = (r, i, k = 0) => r.memory[i].bytes[k];
const wordAt = (r, i, k = 0) => r.memory[i].bytes[k] | (r.memory[i].bytes[k + 1] << 8);

// ------------------------------------------------------------------ 8085 ---
test('8085: ADD stores 08H', () => {
  const r = exec('8085', 'ORG 2000H\nMVI A,05H\nMVI B,03H\nADD B\nSTA 2050H\nHLT', [{ start: 0x2050, length: 1 }]);
  assert.equal(byteAt(r, 0), 8);
});

test('8085: array sum through M', () => {
  const r = exec('8085', `ORG 2000H
 LXI H,2500H
 MVI B,05H
 MVI A,00H
L: ADD M
 INX H
 DCR B
 JNZ L
 STA 2600H
 HLT
 ORG 2500H
 DB 10H,20H,30H,05H,01H`, [{ start: 0x2600, length: 1 }]);
  assert.equal(byteAt(r, 0), 0x66);
});

test('8085: nested loops compute 5! = 120', () => {
  const r = exec('8085', `ORG 2000H
 MVI B,05H
 MVI A,01H
O: MOV C,B
 MOV D,A
 MVI A,00H
I: ADD D
 DCR C
 JNZ I
 DCR B
 JNZ O
 STA 3000H
 HLT`, [{ start: 0x3000, length: 1 }]);
  assert.equal(byteAt(r, 0), 120);
});

test('8085: DAA gives packed BCD 27H', () => {
  const r = exec('8085', 'ORG 2000H\nMVI A,19H\nADI 08H\nDAA\nSTA 3000H\nHLT', [{ start: 0x3000, length: 1 }]);
  assert.equal(byteAt(r, 0), 0x27);
});

test('8085: DAD sets carry on 16-bit overflow', () => {
  const r = exec('8085', 'ORG 2000H\nLXI H,0FFFFH\nLXI B,0001H\nDAD B\nSHLD 3000H\nHLT', [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 0);
  assert.equal(r.flags.CY, 1);
});

test('8085: CALL/RET through the stack', () => {
  const r = exec('8085', 'ORG 2000H\nLXI SP,27FFH\nMVI A,10H\nCALL D\nCALL D\nSTA 3000H\nHLT\nD: ADD A\nRET', [{ start: 0x3000, length: 1 }]);
  assert.equal(byteAt(r, 0), 0x40);
});

test('8085: expressions, $ and negative literals', () => {
  const r = exec('8085', `ORG 2000H
 MVI A,-1
 STA 3000H
 MVI A,SLEN
 STA 3001H
 LXI H,STR+2
 MOV A,M
 STA 3002H
 HLT
STR: DB "CAPSTONE"
SLEN EQU $-STR`, [{ start: 0x3000, length: 3 }]);
  assert.equal(byteAt(r, 0, 0), 0xFF);
  assert.equal(byteAt(r, 0, 1), 8);
  assert.equal(byteAt(r, 0, 2), 'P'.charCodeAt(0));
});

test('8085: RST 5 dispatches through the 0028H vector', () => {
  const r = exec('8085', `ORG 0000H
 JMP GO
 ORG 0028H
 MVI A,55H
 STA 3000H
 JMP FIN
 ORG 2000H
GO: LXI SP,2400H
 RST 5
FIN: HLT`, [{ start: 0x3000, length: 1 }]);
  assert.equal(byteAt(r, 0), 0x55);
});

// ------------------------------------------------------------------ 8086 ---
test('8086: 16-bit ADD to direct memory', () => {
  const r = exec('8086', 'ORG 100H\nMOV AX,1234H\nMOV BX,4321H\nADD AX,BX\nMOV [3000H],AX\nHLT', [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 0x5555);
});

test('8086: based addressing [BX] in a LOOP', () => {
  const r = exec('8086', `ORG 100H
 MOV BX,ARR
 MOV CX,5
 XOR AX,AX
S: ADD AL,[BX]
 INC BX
 LOOP S
 MOV [3000H],AX
 HLT
ARR: DB 10H,20H,30H,40H,50H`, [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 0xF0);
});

test('8086: every effective-address form reads the right cell', () => {
  const r = exec('8086', `ORG 100H
 MOV BX,DATA
 MOV SI,2
 MOV DI,4
 MOV AL,[BX]
 MOV [3000H],AL
 MOV AL,[BX+SI]
 MOV [3001H],AL
 MOV AL,[BX+DI]
 MOV [3002H],AL
 MOV AL,[BX+SI+1]
 MOV [3003H],AL
 HLT
DATA: DB 11H,22H,33H,44H,55H`, [{ start: 0x3000, length: 4 }]);
  assert.deepEqual(r.memory[0].bytes, [0x11, 0x33, 0x55, 0x44]);
});

test('8086: REP MOVSB block copy', () => {
  const r = exec('8086', 'ORG 100H\nMOV SI,S\nMOV DI,2000H\nMOV CX,5\nCLD\nREP MOVSB\nHLT\nS: DB "ABCDE"', [{ start: 0x2000, length: 5 }]);
  assert.equal(String.fromCharCode(...r.memory[0].bytes), 'ABCDE');
});

test('8086: REPNE SCASB measures string length', () => {
  const r = exec('8086', `ORG 100H
 MOV DI,M
 XOR AL,AL
 MOV CX,0FFFFH
 CLD
 REPNE SCASB
 MOV AX,0FFFFH
 SUB AX,CX
 DEC AX
 MOV [3000H],AX
 HLT
M: DB "HELLO WORLD",0`, [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 11);
});

test('8086: MUL and DIV round-trip', () => {
  const r = exec('8086', `ORG 100H
 MOV AX,0234H
 MOV BX,0010H
 MUL BX
 MOV BX,0010H
 DIV BX
 MOV [3000H],AX
 HLT`, [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 0x0234);
});

test('8086: shifts and rotates set CF correctly', () => {
  const r = exec('8086', 'ORG 100H\nMOV AL,80H\nSHL AL,1\nHLT');
  assert.equal(r.registers.AX.value & 0xFF, 0);
  assert.equal(r.flags.CF, 1);
  assert.equal(r.flags.ZF, 1);
});

test('8086: DAA / AAM decimal adjust', () => {
  const daa = exec('8086', 'ORG 100H\nMOV AL,48H\nADD AL,34H\nDAA\nMOV [3000H],AL\nHLT', [{ start: 0x3000, length: 1 }]);
  assert.equal(byteAt(daa, 0), 0x82);
  const aam = exec('8086', 'ORG 100H\nMOV AL,7\nMOV BL,9\nMUL BL\nAAM\nMOV [3000H],AX\nHLT', [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(aam, 0), 0x0603); // 63 -> AH=6, AL=3
});

test('8086: indirect JMP through a jump table', () => {
  const r = exec('8086', `ORG 100H
 MOV BX,2
 SHL BX,1
 JMP TAB[BX]
 HLT
TAB: DW H0,H1,H2,H3
H0: MOV AX,10H
 HLT
H1: MOV AX,11H
 HLT
H2: MOV AX,0AAH
 HLT
H3: MOV AX,33H
 HLT`);
  assert.equal(r.registers.AX.value, 0xAA);
});

test('8086: INT 21H AH=09 writes to the console', () => {
  const r = exec('8086', 'ORG 100H\nMOV DX,M\nMOV AH,9\nINT 21H\nMOV AH,4CH\nINT 21H\nM: DB "HELLO$"');
  assert.equal(r.console, 'HELLO');
});

test('8086: conditional jump beyond +127 is promoted automatically', () => {
  const r = exec('8086', `ORG 100H
 XOR AX,AX
 MOV CX,400
T: INC AX
 DB 200 DUP(90H)
 CMP AX,CX
 JB T
 MOV [3000H],AX
 HLT`, [{ start: 0x3000, length: 2 }]);
  assert.equal(wordAt(r, 0), 400);
});

test('8086: divide by zero is reported as a fault, not a crash', () => {
  const r = runProgram({ source: 'ORG 100H\nMOV AX,10\nMOV BL,0\nDIV BL\nHLT', arch: '8086' });
  assert.equal(r.ok, true);
  assert.match(r.fault, /[Dd]ivision by zero/);
});

// ------------------------------------------------------- built-in examples ---
for (const arch of ['8085', '8086']) {
  for (const ex of EXAMPLES[arch]) {
    test(`${arch} example: ${ex.name}`, () => {
      const r = runProgram({ source: ex.code, arch });
      assert.ok(r.ok, `assembly failed: ${JSON.stringify(r.assembly?.errors)}`);
      assert.equal(r.fault, null);
      assert.equal(r.halted, true, `stopped because: ${r.stopReason}`);
    });
  }
}
