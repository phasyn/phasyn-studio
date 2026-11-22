/** Distinguish equal text or diagnostics while keeping other rows stable when a list changes. */
export function withOccurrenceKeys<T>(items: readonly T[], identity: (item: T) => string): { item: T; key: string }[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const id = identity(item);
    const occurrence = counts.get(id) ?? 0;
    counts.set(id, occurrence + 1);
    return { item, key: JSON.stringify([id, occurrence]) };
  });
}
