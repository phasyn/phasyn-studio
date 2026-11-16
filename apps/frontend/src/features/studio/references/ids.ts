/** 本地 ID（契約：英數字開頭，只含 A–Z a–z 0–9 _ . : -）。 */
export function newLocalId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`;
}
