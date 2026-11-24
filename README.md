# tiny-stack-vm-01

A byte-exact VM for make.fun's tiny stack ISA (v1), written in `main.ts`.
It reads every `/input/<id>/program.bin` + `input.bin` and writes
`/output/<id>/stdout.bin` and `/output/<id>/exit.txt` for all 40 instances.

## ISA quirks this VM honors

- **32-bit wrap**: every arithmetic result is a signed two's-complement i32.
  ADD/SUB/NEG use `|0`; MUL is `Math.imul` (low 32 bits); PUSH32's final
  `<<24` wraps into the sign bit.
- **Division**: DIV truncates toward zero; `INT_MIN / -1` = `INT_MIN`,
  `x % -1` = 0; MOD's remainder takes the sign of the dividend; DIVU/MODU and
  LTU read operands as unsigned and read the result back as signed; `b = 0`
  traps 4.
- **Shifts**: only the low 5 bits of the count matter (`b & 31`); SHR is
  arithmetic, SHRU is logical.
- **PUSH8** sign-extends (0xFF = -1); **EXIT** uses `v & 255`.
- **Traps** end the run at once with their code (2 underflow, 3 overflow,
  4 div-by-zero, 5 bad opcode, 6 bad address, 7 call overflow, 8 empty RET,
  9 pc/immediate out of range, 10 step limit, 11 output limit) and keep the
  bytes written before the trap. CHECK pop/push is done before effects.
- Falling off the end traps 9; a jump target is only checked at the next step.
- **IN** returns -1 once input is exhausted, every time after.
- Output is capped at 65,536 bytes; program steps at 1,000,000.

## Run the grader

    cd C:/Users/sandry-pc/makefun/tsv/tiny-stack-vm-01-run-20261122-kit
    node cli/makefun.mjs grade-local --kit . --bot C:/Users/sandry-pc/Desktop/tsv-entry --driver process

Expected: `score 1000000`, `passed 1`, `instances 40`.
