// Tiny stack VM for make.fun's tiny-stack ISA v1.
// Executes each program.bin with its input.bin and emits byte-exact stdout plus exit code.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per-opcode metadata: immediate byte count (+1, 0 means unknown opcode),
// values popped, values pushed.
const IMM = new Uint8Array(256), POP = new Uint8Array(256), PUSH = new Uint8Array(256);
for (const [o, i, p, q] of [
  [1,1,0,1],[2,4,0,1],[3,0,1,0],[4,0,1,2],[5,0,2,2],[6,0,2,3],[7,0,3,3],
  [0x10,0,2,1],[0x11,0,2,1],[0x12,0,2,1],[0x13,0,2,1],[0x14,0,2,1],[0x15,0,2,1],[0x16,0,2,1],
  [0x17,0,1,1],[0x18,0,2,1],[0x19,0,2,1],[0x1a,0,2,1],[0x1b,0,1,1],[0x1c,0,2,1],[0x1d,0,2,1],[0x1e,0,2,1],
  [0x20,0,2,1],[0x21,0,2,1],[0x22,0,2,1],[0x30,2,0,0],[0x31,2,1,0],[0x32,2,1,0],[0x33,2,0,0],[0x34,0,0,0],
  [0x40,0,1,1],[0x41,0,2,0],[0x50,0,1,0],[0x51,0,1,0],[0x52,0,0,1],[0x53,0,1,0]
]) { IMM[o] = i + 1; POP[o] = p; PUSH[o] = q; }
IMM[0] = 1;

// Reinterpret a byte as a signed 8-bit value (sign-extend), used by PUSH8.
const sx8 = (x) => (x << 24) >> 24;

function run(program, input) {
  const n = program.length;
  const D = new Int32Array(256);   // data stack
  const C = new Int32Array(64);    // call stack of return addresses
  const M = new Int32Array(256);   // 256 words of memory
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, ip = 0, pc = 0, steps = 0;
  const done = (e) => ({ out: out.subarray(0, olen), exit: e });
  const fail = (t) => done(t);

  for (;;) {
    if (steps === 1000000) return fail(10); // step-limit trap: exit 10, partial output kept
    if (pc < 0 || pc >= n) return fail(9);
    const op = program[pc];
    const meta = IMM[op];
    if (!meta) return fail(5);
    const imm = meta - 1;
    if (pc + imm >= n) return fail(9);
    steps++;
    const next = pc + 1 + imm;
    const pops = POP[op];
    const pushes = PUSH[op];
    if (sp < pops) return fail(2);
    if (sp - pops + pushes > 256) return fail(3);
    pc = next;

    switch (op) {
      case 0: return done(0);
      case 1: D[sp++] = sx8(program[next-1]); break;
      // PUSH32: reassemble the little-endian word; the final <<24 lands in bit 31, so the value wraps to signed i32.
      case 2: {
        const v = program[next - 4] | (program[next - 3] << 8) | (program[next - 2] << 16) | (program[next - 1] << 24);
        D[sp++] = v;
        break;
      }
      case 3: sp--; break;
      case 4: D[sp] = D[sp-1]; sp++; break;
      case 5: { const t = D[sp-1]; D[sp-1] = D[sp-2]; D[sp-2] = t; break; }
      case 6: D[sp] = D[sp-2]; sp++; break;
      case 7: { const t = D[sp-3]; D[sp-3] = D[sp-2]; D[sp-2] = D[sp-1]; D[sp-1] = t; break; }
      case 0x17: D[sp-1] = -D[sp-1] | 0; break;
      case 0x1b: D[sp-1] = ~D[sp-1]; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        // Binary arithmetic/bitwise group. Operands: b = top, a = next.
        // Integer semantics are deliberately quirky and must match vm.mjs:
        //   DIV truncates toward zero, and INT_MIN / -1 stays INT_MIN instead of overflowing;
        //   MOD takes the sign of the dividend, and x % -1 is 0;
        //   DIVU/MODU reinterpret both operands as unsigned, then read the result back as signed;
        //   shifts use only the low 5 bits of the count (b & 31), SHR is arithmetic, SHRU logical;
        //   LTU compares as unsigned while LT compares as signed. Any divide by zero traps with code 4.
        const b = D[sp-1], a = D[sp-2];
        let r = 0;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13: if (!b) return fail(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break;
          case 0x14: if (!b) return fail(4); r = b === -1 ? 0 : (a % b) | 0; break;
          case 0x15: if (!b) return fail(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
          case 0x16: if (!b) return fail(4); r = ((a >>> 0) % (b >>> 0)) | 0; break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          case 0x22: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
        }
        sp -= 2; D[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((program[next-2] | (program[next-1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: if (csp === 64) return fail(7); C[csp++] = next; pc = program[next-2] | (program[next-1] << 8); break;
      case 0x34: if (!csp) return fail(8); pc = C[--csp]; break;
      case 0x40: { const addr = D[sp-1]; if (addr < 0 || addr > 255) return fail(6); D[sp-1] = M[addr]; break; }
      case 0x41: { const addr = D[sp-1], v = D[sp-2]; if (addr < 0 || addr > 255) return fail(6); sp -= 2; M[addr] = v; break; }
      case 0x50: {
        const s = String(D[sp-1]);
        if (olen + s.length > 65536) return fail(11);
        sp--;
        for (let k = 0; k < s.length; k++) out[olen++] = s.charCodeAt(k);
        break;
      }
      case 0x51: if (olen + 1 > 65536) return fail(11); out[olen++] = D[--sp] & 255; break;
      case 0x52: D[sp++] = ip < input.length ? input[ip++] : -1; break;
      case 0x53: return done(D[--sp] & 255);
    }
  }
}

for (const id of readdirSync(I).sort()) {
  mkdirSync(join(O, id), { recursive: true });
  const program = readFileSync(join(I, id, 'program.bin'));
  const data = readFileSync(join(I, id, 'input.bin'));
  const result = run(program, data);
  writeFileSync(join(O, id, 'stdout.bin'), result.out);
  writeFileSync(join(O, id, 'exit.txt'), String(result.exit) + '\n');
}
