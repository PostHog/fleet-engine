import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const envFiles = { ".env": "CHECKOUT_ENV", ".env.local": "CHECKOUT_ENV_LOCAL", ".env.development": "CHECKOUT_ENV_DEVELOPMENT", ".env.production": "CHECKOUT_ENV_PRODUCTION", ".env.test": "CHECKOUT_ENV_TEST" };

export const nodeEnvs = [undefined, "production", "test"] as const;

export function bunCheckout(temp: { make(prefix?: string): string }) {
  const dir = temp.make("checkout-");
  const marker = join(dir, "preloaded");
  for (const [file, name] of Object.entries(envFiles)) writeFileSync(join(dir, file), `${name}=from-checkout\n`);
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(dir, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "");\n`);
  return { dir, preloaded: () => existsSync(marker) };
}
