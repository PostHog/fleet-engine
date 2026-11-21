export const bunScript = (script: string, ...args: string[]) => [process.execPath, "--no-env-file", "--config=/dev/null", script, ...args];
