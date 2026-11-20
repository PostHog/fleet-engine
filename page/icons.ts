const drawn = (shapes: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;

const slackLogo = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path fill="var(--slack-red)" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"/>
<path fill="var(--slack-blue)" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"/>
<path fill="var(--slack-green)" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"/>
<path fill="var(--slack-yellow)" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
</svg>`;

export const packIcons: Record<string, string> = {
  base: drawn(`<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>`),
  "pull-requests": drawn(`<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 15.5V10a3 3 0 0 0-3-3h-3"/><path d="m14 4.5-2.5 2.5L14 9.5"/>`),
  orchestration: drawn(`<rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="2.5" y="16" width="5.5" height="5" rx="1.2"/><rect x="9.25" y="16" width="5.5" height="5" rx="1.2"/><rect x="16" y="16" width="5.5" height="5" rx="1.2"/><path d="M12 8v8"/><path d="M5.25 16v-2.5a1.5 1.5 0 0 1 1.5-1.5h10.5a1.5 1.5 0 0 1 1.5 1.5V16"/>`),
  communication: drawn(`<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8Z"/><path d="M8 8h8"/><path d="M8 11.5h5"/>`),
  memory: drawn(`<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/><path d="M10 3v7l2.5-2 2.5 2V3"/>`),
  guards: drawn(`<path d="M12 3 5 5.5v5.8c0 4.3 2.9 7.9 7 9.7 4.1-1.8 7-5.4 7-9.7V5.5L12 3Z"/><path d="m9 11.8 2.2 2.2 3.8-4.2"/>`),
  hub: drawn(`<circle cx="12" cy="12.4" r="2.7" fill="currentColor"/><rect x="9.25" y="2" width="5.5" height="4.6" rx="1.3"/><rect x="1.75" y="16.6" width="5.5" height="4.6" rx="1.3"/><rect x="16.75" y="16.6" width="5.5" height="4.6" rx="1.3"/><path d="M12 6.6v3.1"/><path d="m9.8 14.2-3 2.4"/><path d="m14.2 14.2 3 2.4"/>`),
  security: drawn(`<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>`),
  "mcp-gateway": drawn(`<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z"/><path d="M12 17v4"/>`),
  herdr: drawn(`<rect x="2.5" y="4" width="13" height="11" rx="1.8"/><path d="m5.5 8 2.5 2-2.5 2"/><path d="M9.5 12.5h3"/><rect x="15.5" y="9" width="6" height="11" rx="1.5"/><path d="M18 17.5h1"/>`),
  slack: slackLogo,
  "incident-io": drawn(`<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M12 3v2"/>`),
};

export const teamIcon = drawn(`<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.4-3.4 2.9-5.5 6-5.5s5.6 2.1 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.4.2 4.1 2 4.5 4.9"/>`);

export const brandIcons = new Set(["slack"]);

export const packIcon = (name: string) => packIcons[name] ?? teamIcon;

export const uiIcons = {
  arrow: drawn(`<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`),
  play: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
};
