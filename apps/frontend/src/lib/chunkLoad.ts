// Recognises a failed dynamic import (a lazy chunk that could not be fetched or evaluated).

/** Chromium/Firefox: "…dynamically imported module…", Safari: "Importing a module script failed". */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|importing a module script failed|ChunkLoadError/i.test(`${error.name} ${error.message}`);
}
