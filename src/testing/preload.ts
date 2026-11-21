import { bundledThreadVariables } from "../runtime/active.ts";
import { memoryTemp } from "./memory-temp.ts";

memoryTemp(process.env, { memory: "/dev/shm", pid: process.pid });
for (const name of bundledThreadVariables()) delete process.env[name];
