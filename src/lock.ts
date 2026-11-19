import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export type Held = { release(): void };

const exclusive = 2;
const noWait = 4;
const pollMs = 250;

let libc: ReturnType<typeof openLibc> | undefined;

function openLibc() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}

/**
 * Takes an exclusive flock on the file at path without waiting.
 * The kernel drops the lock when its process ends, so a dead holder never blocks the next run.
 */
export function tryLock(path: string, { follow = true } = {}): Held | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (follow ? 0 : constants.O_NOFOLLOW), 0o600);
  libc ??= openLibc();
  if (libc.symbols.flock(fd, exclusive | noWait) !== 0) {
    closeSync(fd);
    return undefined;
  }
  return {
    release() {
      closeSync(fd);
    },
  };
}

export const stateLock = ".local/state/hedge/hedge.lock";

export function holdLock(path: string): Held {
  const held = tryLock(path);
  if (!held) throw new Error(`Another Hedge operation holds ${path}. Run this again once it ends.`);
  return held;
}

/** Waits up to limitMs for the lock, asking sleep for each pause. */
export async function waitLock(path: string, sleep: (ms: number) => Promise<void>, limitMs: number): Promise<Held | undefined> {
  for (let waited = 0; ; waited += pollMs) {
    const held = tryLock(path);
    if (held || waited >= limitMs) return held;
    await sleep(pollMs);
  }
}
