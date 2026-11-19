import { serve } from "./server.ts";

const library = process.env.HEDGE_CONTEXT_LIBRARY;
if (!library) {
  process.stderr.write("Set HEDGE_CONTEXT_LIBRARY to the library folder.\n");
  process.exit(2);
}
await serve(
  { library, url: process.env.HEDGE_CONTEXT_URL || undefined },
  process.stdin,
  (line) => process.stdout.write(`${line}\n`),
);
