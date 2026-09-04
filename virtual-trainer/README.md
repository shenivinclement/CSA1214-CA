# Web-Based 8085/8086 Virtual Trainer & Assembler-Simulator

A browser-based Intel **8085** and **8086** trainer: a two-pass assembler, cycle-stage CPU
simulators, an interactive debugger, and a REST API — deployable to Vercel as a static
frontend plus serverless functions.

---

## Architecture

The defining idea is an **isomorphic core**. The assembler and both CPU engines are plain
ES modules with no DOM and no Node APIs, so *the exact same code* powers the interactive
browser trainer and the server-side API. There is one instruction table per architecture,
and it cannot drift between client and server.

```
                        ┌───────────────────────────┐
                        │        core/  (ESM)       │
                        │  expr.js      assembler.js│
                        │  cpu8085.js   cpu8086.js  │
                        │  runner.js    common.js   │
                        └─────────────┬─────────────┘
                    imports           │           imports
          ┌───────────────────────────┴──────────────────────────┐
          ▼                                                      ▼
 ┌──────────────────┐                                ┌──────────────────────┐
 │  js/ui.js        │   fetch  POST /api/run   ───▶  │  api/run.js          │
 │  (browser)       │ ◀───────  JSON result          │  api/assemble.js     │
 │                  │                                │  api/health.js       │
 │ editor · FSM     │                                │  (Vercel functions)  │
 │ registers · mem  │                                └──────────────────────┘
 └──────────────────┘
```

The **Server** tab runs your program on both engines and diffs every register, flag and
requested memory range — a live demonstration that the client and server produce
identical results.

### Layout

| Path | Role |
|---|---|
| `core/common.js` | Hex/bit helpers, `CpuRuntimeError` |
| `core/expr.js` | Operand expression evaluator (labels, `$`, `HIGH/LOW/OFFSET`, arithmetic) |
| `core/cpu8085.js` | 8085 encoder + 5-stage execution engine |
| `core/cpu8086.js` | 8086 encoder + 5-stage execution engine (full ModRM addressing) |
| `core/assembler.js` | Two-pass driver, directives, branch relaxation |
| `core/runner.js` | Headless assemble/execute used by the API **and** by the browser diff |
| `api/*.js` | Serverless HTTP endpoints (thin wrappers over `core/runner.js`) |
| `js/ui.js` | Browser UI: editor, debugger, panels, API client |
| `server.mjs` | Zero-dependency local dev server (static + `/api`) |
| `tests/` | `node:test` suites for the engines and the live HTTP API |

---

## Running locally

No dependencies to install — the project has none.

```bash
npm run dev          # http://localhost:3000
```

```bash
npm test             # 49 engine + API tests
```

> **Note:** the frontend uses ES modules, so opening `index.html` directly from disk
> (`file://`) will not work — browsers block module imports over `file://`. Always use
> `npm run dev` or the deployed URL.

---

## Deploying to Vercel

### Option A — Vercel CLI

```bash
npm i -g vercel
vercel login
vercel            # preview deployment
vercel --prod     # production deployment
```

### Option B — Git (recommended)

```bash
git init
git add .
git commit -m "8085/8086 virtual trainer"
git branch -M main
git remote add origin https://github.com/<you>/8085-8086-virtual-trainer.git
git push -u origin main
```

Then at [vercel.com/new](https://vercel.com/new): import the repository and deploy.

**Project settings:**

| Setting | Value |
|---|---|
| Framework Preset | `Other` |
| **Root Directory** | **`virtual-trainer`** — set this if the app lives in a subfolder of the repo (as it does in `CSA1214-CA`); leave blank if the app is at the repo root |
| Build Command | *(empty)* |
| Output Directory | *(empty)* |
| Install Command | *(empty)* |

There is no build step. Vercel serves the root directory as static files and turns each
file in `api/` into a Node serverless function automatically.

Setting **Root Directory** also acts as a hard boundary: Vercel never sees anything
outside that folder, so unrelated files elsewhere in the repository cannot be deployed.

> `.vercelignore` deliberately excludes `*.docx`, `*.pptx` and `*.pdf`. Anything deployed
> is **publicly downloadable by URL**, so the capstone report and slide deck are kept out
> of the deployment.

---

## REST API

Base URL: your deployment origin (or `http://localhost:3000`). CORS is open — these
endpoints are stateless pure compute with no authentication and no stored data.

### `GET /api/health`

Status, supported architectures, limits, and a self-test that actually executes a small
8085 program on every call.

```bash
curl https://<your-app>.vercel.app/api/health
```

### `POST /api/assemble`

Assemble only. Returns the listing, symbol table and machine code.

```bash
curl -X POST https://<your-app>.vercel.app/api/assemble \
  -H 'content-type: application/json' \
  -d '{"source":"ORG 100H\nSTART: MOV AX,1234H\nHLT","arch":"8086"}'
```

```json
{
  "ok": true,
  "hex": "B8 34 12 F4",
  "byteCount": 4,
  "symbols": { "START": { "value": 256, "hex": "0100" } },
  "listing": [ { "line": 2, "addressHex": "0100", "bytesHex": "B8 34 12", "mnemonic": "MOV", "operands": ["AX","1234H"] } ],
  "errors": []
}
```

A program with syntax errors returns **422** with `errors: [{ line, message }]`.

### `POST /api/run`

Assemble **and** execute headlessly to `HLT`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `source` | string | *required* | Assembly text (max 128 KB) |
| `arch` | `"8085"` \| `"8086"` | `"8085"` | |
| `maxInstructions` | number | `1000000` | Capped at 5,000,000 server-side |
| `memory` | `[{start,length}]` | `[]` | Up to 8 ranges, ≤4096 bytes each |

```bash
curl -X POST https://<your-app>.vercel.app/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"ORG 100H\nMOV AX,1234H\nMOV BX,4321H\nADD AX,BX\nMOV [3000H],AX\nHLT","arch":"8086","memory":[{"start":12288,"length":2}]}'
```

```json
{
  "ok": true,
  "halted": true,
  "stopReason": "halted",
  "instructions": 5,
  "registers": { "AX": { "value": 21845, "hex": "5555" } },
  "flags": { "CF": 0, "ZF": 0, "SF": 0, "OF": 0, "PF": 1, "AF": 0, "DF": 0, "IF": 0 },
  "memory": [ { "startHex": "3000", "hex": "55 55" } ],
  "console": "",
  "trace": [ { "addressHex": "0100", "bytes": "B8 34 12", "text": "MOV AX,1234H" } ]
}
```

A program that **assembles but faults** at runtime (divide by zero, unimplemented `INT`)
still returns **200** with `fault` set — that is a normal result for a trainer. Only a
program that fails to *assemble* returns 422; malformed requests return 400.

Execution is bounded by both an instruction limit and a 5-second wall clock, so an
infinite loop returns `stopReason: "instruction-limit"` or `"time-limit"` rather than
hanging the function.

---

## Instruction support

**8085 — complete instruction set.** All data transfer, arithmetic, logical, branch,
stack and machine-control instructions, including `DAA`, `RIM`/`SIM`, `XTHL`, `PCHL`,
`RST 0-7` and every conditional call/return.

**8086 — real-mode subset with authentic opcodes.** Full ModRM addressing
(`[BX]`, `[SI]`, `[BP+DI]`, `[BX+SI+4]`, `LABEL[SI]`, direct `[1234H]`), the arithmetic,
logic, shift and rotate groups, `MUL`/`IMUL`/`DIV`/`IDIV`, BCD adjust
(`DAA DAS AAA AAS AAM AAD`), string primitives (`MOVS STOS LODS SCAS CMPS` with
`REP`/`REPE`/`REPNE`), stack and flag control, `XCHG`/`TEST`/`LEA`/`XLAT`/`CBW`/`CWD`,
`INT 21H`/`20H`/`10H` services, and every conditional jump. Conditional jumps beyond
±127 bytes are relaxed automatically into an inverted jump over a near `JMP`.
Memory is one flat 64 KB space; segment registers exist but do not translate addresses.

Assembler directives: `ORG`, `DB`, `DW`, `DS`, `EQU`, `END`, with `DUP`, `?`, string
literals, and full expression operands (`+ - * / % & | ^ << >>`, `$`, `HIGH`, `LOW`,
`OFFSET`).

---

## License

MIT
