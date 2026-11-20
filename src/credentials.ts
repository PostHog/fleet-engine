export function withoutCredentials(line: string) {
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (found) => {
    const address = found.replace(/['"`.,:;)\]>]+$/, "");
    const after = found.slice(address.length);
    try {
      const url = new URL(address);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}${after}`;
    } catch {
      return `the remote${after}`;
    }
  });
}
