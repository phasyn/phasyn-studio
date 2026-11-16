// Text diffs (pure): one Myers O(ND) implementation over sequences, used line by line (the prompt format preview and the
// fix preview) and character by character (changed lines, candidate comparisons). JSON document diffs are lib/diff.ts.
export type DiffOp = "equal" | "delete" | "insert";

export interface DiffChunk<T> {
  op: DiffOp;
  items: T[];
}

/** Shortest edit script (one op per item); more than maxEdits edits → null (the caller replaces the whole range). */
function myers<T>(a: readonly T[], b: readonly T[], maxEdits: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEdits) && found < 0; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const snapshot = trace[d];
    if (!snapshot) return null;
    const at = (k: number) => snapshot[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push("equal");
      x -= 1;
      y -= 1;
    }
    ops.push(down ? "insert" : "delete");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    ops.push("equal");
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function push<T>(chunks: DiffChunk<T>[], op: DiffOp, item: T): void {
  const last = chunks[chunks.length - 1];
  if (last && last.op === op) last.items.push(item);
  else chunks.push({ op, items: [item] });
}

/** Diff of two sequences (the equal head and tail are trimmed first to keep the cost down). */
export function diffSequences<T>(a: readonly T[], b: readonly T[], maxEdits = 2000): DiffChunk<T>[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const ops = myers(midA, midB, maxEdits) ?? [...midA.map((): DiffOp => "delete"), ...midB.map((): DiffOp => "insert")];
  const chunks: DiffChunk<T>[] = [];
  for (const item of a.slice(0, prefix)) push(chunks, "equal", item);
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") {
      push(chunks, "equal", midA[i] as T);
      i += 1;
      j += 1;
    } else if (op === "delete") {
      push(chunks, "delete", midA[i] as T);
      i += 1;
    } else {
      push(chunks, "insert", midB[j] as T);
      j += 1;
    }
  }
  for (const item of a.slice(a.length - suffix)) push(chunks, "equal", item);
  return chunks;
}

/** Marks the positions within `context` of a change; the others may be collapsed. */
function nearChanges(changed: readonly boolean[], context: number): boolean[] {
  const keep = changed.map(() => false);
  changed.forEach((isChange, index) => {
    if (!isChange) return;
    for (let k = Math.max(0, index - context); k <= Math.min(changed.length - 1, index + context); k += 1) keep[k] = true;
  });
  return keep;
}

export interface InlinePart {
  op: DiffOp;
  text: string;
}

export type PreviewRow =
  | { kind: "same"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "added"; text: string }
  | { kind: "changed"; parts: InlinePart[] };

/** Character diff (by code point, so emoji are never split). */
export function diffChars(before: string, after: string): InlinePart[] {
  return diffSequences(Array.from(before), Array.from(after), 4000).map((chunk) => ({ op: chunk.op, text: chunk.items.join("") }));
}

/** Rows of the format preview: same, removed and added lines, and paired changed lines (with their character diff). */
export function previewRows(before: string, after: string): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const chunks = diffSequences(before.split("\n"), after.split("\n"));
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    if (chunk.op === "equal") {
      for (const text of chunk.items) rows.push({ kind: "same", text });
      continue;
    }
    const next = chunks[index + 1];
    if (chunk.op === "delete" && next?.op === "insert") {
      const pairs = Math.min(chunk.items.length, next.items.length);
      for (let p = 0; p < pairs; p += 1) rows.push({ kind: "changed", parts: diffChars(chunk.items[p] ?? "", next.items[p] ?? "") });
      for (const text of chunk.items.slice(pairs)) rows.push({ kind: "removed", text });
      for (const text of next.items.slice(pairs)) rows.push({ kind: "added", text });
      index += 1;
      continue;
    }
    for (const text of chunk.items) rows.push({ kind: chunk.op === "delete" ? "removed" : "added", text });
  }
  return rows;
}

export type CollapsedRow = { type: "row"; row: PreviewRow } | { type: "skip"; count: number };

/** Collapses long runs of unchanged preview rows, keeping `context` rows before and after each change. */
export function collapseRows(rows: readonly PreviewRow[], context = 1): CollapsedRow[] {
  const keep = nearChanges(rows.map((row) => row.kind !== "same"), context);
  const out: CollapsedRow[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ type: "skip", count: skipped });
      skipped = 0;
      out.push({ type: "row", row });
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ type: "skip", count: skipped });
  return out;
}

export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
}

export interface DiffHunk {
  /** Unchanged lines skipped before this hunk. */
  skipped: number;
  lines: DiffLine[];
}

const LINE_KIND: Record<DiffOp, DiffLine["kind"]> = { equal: "same", delete: "del", insert: "add" };

/** Line diff of the fix preview: every line of both texts in order, marked same / del / add. */
export function diffLines(before: string, after: string): DiffLine[] {
  return diffSequences(before.split("\n"), after.split("\n")).flatMap((chunk) => chunk.items.map((text): DiffLine => ({ kind: LINE_KIND[chunk.op], text })));
}

/** Keeps only the changes and `context` lines around them; the other unchanged lines collapse into "n lines skipped". */
export function diffHunks(lines: readonly DiffLine[], context = 1): DiffHunk[] {
  const keep = nearChanges(lines.map((line) => line.kind !== "same"), context);
  const hunks: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffHunk | null = null;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      skipped += 1;
      current = null;
      return;
    }
    if (!current) {
      current = { skipped, lines: [] };
      hunks.push(current);
      skipped = 0;
    }
    current.lines.push(line);
  });
  return hunks;
}

/** Number of added and removed lines. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((line) => line.kind === "add").length, removed: lines.filter((line) => line.kind === "del").length };
}
