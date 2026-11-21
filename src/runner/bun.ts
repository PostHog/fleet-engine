export const ownBunOptions = ["--no-env-file", "--config=/dev/null"] as const;

export const bunScript = (script: string, ...args: string[]) => [process.execPath, ...ownBunOptions, script, ...args];
