// The Chromium PDF component imports bundled WebUI modules and theme CSS.
// This allowlist belongs only to the isolated, memory-only PDF session.
export function allowsPdfResource(value: string, current: string | null): boolean {
  return (current !== null && value === current)
    || value.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')
    || value.startsWith('chrome://resources/')
    || value.startsWith('chrome://theme/');
}

export function allowsPdfFrame(value: string): boolean {
  return /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}
