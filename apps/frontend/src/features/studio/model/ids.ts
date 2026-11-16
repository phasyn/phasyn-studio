// Document-local identifiers (shots, takes, clips, markers): unique enough within one project document.

export function localId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`.slice(0, 40);
}
