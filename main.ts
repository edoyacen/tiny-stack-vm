// Hand-written tiny stack virtual machine for make.fun's tiny-stack ISA v1.
// Runs each program.bin beside its input.bin and writes byte-exact stdout plus exit code.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per opcode: immediate byte count (+1, 0 means unknown opcode), values popped, values pushed.
const META = new Uint8Array(256), TAKE = new Uint8Array(256), MAKE = new Uint8Array(256);
for (const [opcode, immediates, pops, pushes] of [
  [1,1,0,1],[2,4,0,1],[3,0,1,0],[4,0,1,2],[5,0,2,2],[6,0,2,3],[7,0,3,3],
  [0x10,0,2,1],[0x11,0,2,1],[0x12,0,2,1],[0x13,0,2,1],[0x14,0,2,1],[0x15,0,2,1],[0x16,0,2,1],
  [0x17,0,1,1],[0x18,0,2,1],[0x19,0,2,1],[0x1a,0,2,1],[0x1b,0,1,1],[0x1c,0,2,1],[0x1d,0,2,1],[0x1e,0,2,1],
  [0x20,0,2,1],[0x21,0,2,1],[0x22,0,2,1],[0x30,2,0,0],[0x31,2,1,0],[0x32,2,1,0],[0x33,2,0,0],[0x34,0,0,0],
  [0x40,0,1,1],[0x41,0,2,0],[0x50,0,1,0],[0x51,0,1,0],[0x52,0,0,1],[0x53,0,1,0]
]) { META[opcode] = immediates + 1; TAKE[opcode] = pops; MAKE[opcode] = pushes; }
META[0] = META[0] + 1;

// Reinterpret a byte as a signed 8-bit value (sign-extend), used by PUSH8.
// If bit 7 is set, subtract 256 (the two's-complement weight of the high bit).
const sx8 = (x) => x - ((x & 0x80) << 1);

function run(program, input) {
  const size = program.length;
  const stack = new Int32Array(256);   // data stack
  const calls = new Int32Array(64);    // call stack of return addresses
  const memory = new Int32Array(256); // 256 words of memory
  const buf = new Uint8Array(65536);
  let sp = 0, csp = 0, len = 0, src = 0, ptr = 0, guard = 0;
  const finish = (code) => ({ buf: buf.subarray(0, len), exit: code });
  const trap = (code) => finish(code);

  for (;;) {
    if (guard >= 1000000) { return trap(10); } // step-limit trap: exit 10, partial output kept
    if (ptr < 0 || ptr >= size) return trap(9);
    const opcode = program[ptr];
    const imm = META[opcode] - 1;
    if (imm < 0) return trap(5);
    const operand = ptr + imm + 1;
    if (operand > size) return trap(9);
    guard++;
    const pops = TAKE[opcode];
    const pushes = MAKE[opcode];
    if (sp < pops) { return trap(2); }
    if (sp - pops + pushes > 256) { return trap(3); }
    ptr = operand;

    switch (opcode) {
      case 0: return finish(0);
      case 1: stack[sp] = sx8(program[operand - 1]); sp++; break;
      case 2: {
        let v = 0;
        for (let k = 0; k < 4; k++) v |= program[operand - 4 + k] << (k * 8);
        stack[sp++] = v | 0;
        break;
      }
      case 3: sp--; break;
      case 4: stack[sp] = stack[sp - 1]; sp++; break;
      case 5: { const lo = sp - 2, hi = sp - 1; const t = stack[hi]; stack[hi] = stack[lo]; stack[lo] = t; break; }
      case 6: stack[sp] = stack[sp - 2]; sp++; break;
      case 7: { const t = stack[sp - 3]; stack[sp - 3] = stack[sp - 2]; stack[sp - 2] = stack[sp - 1]; stack[sp - 1] = t; break; }
      case 0x17: stack[sp - 1] = (0 - stack[sp - 1]) | 0; break;
      case 0x1b: stack[sp - 1] = ~stack[sp - 1]; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = stack[sp - 1];
        const a = stack[sp - 2];
        let r = 0;
        switch (opcode) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13: {
            if (b === 0) return trap(4);
            const overflow = a === -2147483648 && b === -1;
            r = overflow ? a : (a / b) | 0;
            break;
          }
          case 0x14: {
            if (b === 0) return trap(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          }
          case 0x15: {
            if (b === 0) return trap(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          }
          case 0x16: {
            if (b === 0) return trap(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          }
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
        sp -= 2; stack[sp] = r; sp++;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const encoded = program[operand - 2] | (program[operand - 1] << 8);
        const rel = (encoded << 16) >> 16;
        let take = opcode === 0x30;
        if (!take) {
          const v = stack[--sp];
          take = opcode === 0x31 ? v === 0 : v !== 0;
        }
        if (take) ptr = operand + rel;
        break;
      }
      case 0x33: {
        if (csp === 64) return trap(7);
        calls[csp++] = operand;
        ptr = program[operand - 2] | (program[operand - 1] << 8);
        break;
      }
      case 0x34: {
        if (csp === 0) return trap(8);
        ptr = calls[--csp];
        break;
      }
      case 0x40: {
        const addr = stack[sp - 1];
        if ((addr >>> 0) > 255) return trap(6);
        stack[sp - 1] = memory[addr];
        break;
      }
      case 0x41: {
        const addr = stack[sp - 1];
        if ((addr >>> 0) > 255) return trap(6);
        memory[addr] = stack[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: {
        const s = String(stack[sp - 1]);
        if (len + s.length > 65536) return trap(11);
        sp--;
        for (let k = 0; k < s.length; k++) buf[len + k] = s.charCodeAt(k);
        len += s.length;
        break;
      }
      case 0x51: {
        if (len + 1 > 65536) return trap(11);
        buf[len++] = stack[--sp] & 255;
        break;
      }
      case 0x52: { const avail = src < input.length; stack[sp++] = avail ? input[src] : -1; if (avail) src++; break; }
      case 0x53: return finish(stack[--sp] & 255);
    }
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  const program = readFileSync(join(INPUT_DIR, id, 'program.bin'));
  const data = readFileSync(join(INPUT_DIR, id, 'input.bin'));
  const result = run(program, data);
  writeFileSync(join(OUTPUT_DIR, id, 'stdout.bin'), result.buf);
  writeFileSync(join(OUTPUT_DIR, id, 'exit.txt'), String(result.exit) + '\n');
}
