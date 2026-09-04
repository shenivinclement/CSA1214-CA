'use strict';

export const EXAMPLES = {
  '8085': [
    {
      name: 'Add two numbers',
      code: `; Add two 8-bit numbers and store the result in memory
        ORG 2000H
        MVI A,05H       ; A = 05H
        MVI B,03H       ; B = 03H
        ADD B           ; A = A + B
        STA 2050H       ; store result at 2050H
        HLT`,
    },
    {
      name: 'Largest of two numbers',
      code: `; Find the larger of two numbers, store it at 2050H
        ORG 2000H
        MVI A,3EH
        MVI B,25H
        CMP B           ; compare A with B (sets flags, A unchanged)
        JNC STORE       ; if A >= B, jump ahead
        MOV A,B         ; else A = B
STORE:  STA 2050H
        HLT`,
    },
    {
      name: 'Sum of an array (loop)',
      code: `; Sum N bytes starting at 2500H, result (8-bit) at 2600H
        ORG 2000H
        LXI H,2500H     ; HL = array pointer
        MVI B,05H       ; B = count
        MVI A,00H       ; A = running sum
LOOP:   ADD M           ; A = A + [HL]
        INX H
        DCR B
        JNZ LOOP
        STA 2600H
        HLT
        ORG 2500H
        DB 10H,20H,30H,05H,01H`,
    },
    {
      name: 'Block memory copy',
      code: `; Copy 5 bytes from 2500H to 2600H
        ORG 2000H
        LXI H,2500H     ; source pointer
        LXI D,2600H     ; destination pointer
        MVI B,05H       ; count
COPY:   MOV A,M
        STAX D
        INX H
        INX D
        DCR B
        JNZ COPY
        HLT
        ORG 2500H
        DB 0AAH,0BBH,0CCH,0DDH,0EEH`,
    },
    {
      name: 'Multiply (repeated addition)',
      code: `; 8-bit multiply  A = MCND * MPLR  via repeated addition
MCND    EQU 0AH
MPLR    EQU 06H
        ORG 2000H
        MVI B,MCND
        MVI C,MPLR
        MVI A,00H
NEXT:   ADD B
        DCR C
        JNZ NEXT
        STA 2050H       ; expect 3CH (60)
        HLT`,
    },
    {
      name: 'Find largest in array',
      code: `; Largest of COUNT bytes at 2500H -> 2600H
COUNT   EQU 06H
        ORG 2000H
        LXI H,2500H
        MVI C,COUNT
        MOV A,M         ; assume first is largest
LOOP:   INX H
        CMP M
        JNC SKIP        ; A >= [HL] ? keep A
        MOV A,M         ; else take the bigger one
SKIP:   DCR C
        JNZ LOOP
        STA 2600H
        HLT
        ORG 2500H
        DB 23H,7AH,0FFH,10H,0AAH,05H`,
    },
    {
      name: 'BCD counter with DAA',
      code: `; Count 00,01,...,20 in packed BCD, store each at 2600H+
        ORG 2000H
        LXI H,2600H
        MVI A,00H
        MVI C,21H        ; 21 iterations
UP:     MOV M,A
        INX H
        ADI 01H
        DAA              ; decimal-adjust after add
        DCR C
        JNZ UP
        HLT`,
    },
    {
      name: 'Subroutine: sum with CALL/RET',
      code: `; Uses the stack: main calls ADD8 twice
        ORG 2000H
        LXI SP,27FFH
        MVI A,10H
        CALL DBL
        CALL DBL
        STA 2050H        ; expect 40H
        HLT
DBL:    ADD A            ; A = A + A
        RET`,
    },
  ],

  '8086': [
    {
      name: 'Add two 16-bit numbers',
      code: `; Add two 16-bit numbers, result in AX, then store to memory
        ORG 100H
        MOV AX,1234H
        MOV BX,4321H
        ADD AX,BX
        MOV [3000H],AX   ; expect 5555H
        HLT`,
    },
    {
      name: 'Largest of two numbers',
      code: `; Find the larger of two 16-bit numbers, store it at 3000H
        ORG 100H
        MOV AX,00F0H
        MOV BX,0025H
        CMP AX,BX
        JGE STORE
        MOV AX,BX
STORE:  MOV [3000H],AX
        HLT`,
    },
    {
      name: 'Sum an array with [BX] indexing',
      code: `; Sum the bytes of ARR using based addressing, store the 16-bit total
        ORG 100H
        MOV BX,ARR
        MOV CX,LEN
        XOR AX,AX
NEXT:   ADD AL,[BX]
        ADC AH,0          ; carry into the high byte
        INC BX
        LOOP NEXT
        MOV [3000H],AX
        HLT
ARR:    DB 40H,30H,80H,90H,0F0H,11H,22H,33H
LEN     EQU 8`,
    },
    {
      name: 'String copy + uppercase (REP MOVSB / SI-DI)',
      code: `; Copy a string, then upper-case it in place
        ORG 100H
        MOV SI,SRC
        MOV DI,DST
        MOV CX,LEN
        CLD
        REP MOVSB        ; DST <- SRC, CX bytes
        MOV SI,DST
        MOV CX,LEN
UP:     MOV AL,[SI]
        CMP AL,'a'
        JB SKIP
        CMP AL,'z'
        JA SKIP
        SUB AL,20H       ; 'a'..'z' -> 'A'..'Z'
        MOV [SI],AL
SKIP:   INC SI
        LOOP UP
        HLT
SRC:    DB "hello world"
LEN     EQU 11
DST:    DB 11 DUP(0)`,
    },
    {
      name: 'String length via REPNE SCASB',
      code: `; Walk a 0-terminated string, compute its length
        ORG 100H
        MOV DI,MSG
        XOR AL,AL         ; scan for 00
        MOV CX,0FFFFH
        CLD
        REPNE SCASB
        MOV AX,0FFFFH
        SUB AX,CX
        DEC AX            ; AX = length
        MOV [3000H],AX
        HLT
MSG:    DB "8086 VIRTUAL TRAINER",0`,
    },
    {
      name: 'Multiply / divide (MUL, DIV)',
      code: `; 16-bit multiply then divide back
        ORG 100H
        MOV AX,0234H
        MOV BX,0010H
        MUL BX            ; DX:AX = AX * BX
        MOV [3000H],AX    ; low  word
        MOV [3002H],DX    ; high word
        MOV BX,0010H
        DIV BX            ; AX = (DX:AX)/BX , DX = remainder
        MOV [3004H],AX    ; expect 0234H again
        HLT`,
    },
    {
      name: 'Bubble sort (indexed [SI], [SI+1])',
      code: `; Sort ARR ascending, in place
        ORG 100H
        MOV CX,LEN
        DEC CX           ; passes = LEN-1
OUTER:  MOV SI,ARR
        MOV DX,CX
INNER:  MOV AL,[SI]
        MOV BL,[SI+1]
        CMP AL,BL
        JBE NOSWP
        MOV [SI],BL
        MOV [SI+1],AL
NOSWP:  INC SI
        DEC DX
        JNZ INNER
        LOOP OUTER
        HLT
ARR:    DB 8,3,7,1,9,2,6,4,5,0
LEN     EQU 10`,
    },
    {
      name: 'Print a string (INT 21H)',
      code: `; DOS-style teletype output
        ORG 100H
        MOV DX,MSG
        MOV AH,09H       ; print $-terminated string
        INT 21H
        MOV AH,4CH       ; exit
        INT 21H
MSG:    DB "HELLO FROM THE 8086 TRAINER",0DH,0AH,"$"`,
    },
    {
      name: 'Factorial with CALL / stack',
      code: `; 5!  by an iterative subroutine, result at 3000H
        ORG 100H
        MOV SP,0FFFEH
        MOV CX,5
        CALL FACT
        MOV [3000H],AX   ; expect 0078H (120)
        HLT
FACT:   MOV AX,1
FL:     MUL CX
        LOOP FL
        RET`,
    },
  ],
};
