// Build step: writes a gzip copy (<file>.gz) next to each text file of the build output. The Controller sends that copy
// with Content-Encoding: gzip to clients that accept it (packages/controller/src/phasyn_controller/static.py), so the
// app, its styles and the translation catalogs travel compressed without compressing on every request. node:zlib only.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/** Text formats worth compressing (images and fonts are compressed already). */
export const COMPRESSIBLE = /\.(?:css|html|js|json|mjs|svg|txt|webmanifest|xml)$/i;
/** Smaller files gain nothing worth an extra file and a request header. */
export const MIN_BYTES = 1024;

/**
 * Writes `<file>.gz` for every compressible file under `dir` of at least `minBytes` whose gzip copy is at least 10 %
 * smaller; returns the files written (relative to `dir`). An existing `.gz` is rewritten, so a rerun stays in sync.
 */
export function precompressDir(dir, { minBytes = MIN_BYTES } = {}) {
  const written = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && COMPRESSIBLE.test(entry.name) && statSync(join(dir, path)).size >= minBytes) {
        const source = readFileSync(join(dir, path));
        const gz = gzipSync(source, { level: 9 });
        if (gz.length > source.length * 0.9) continue;
        writeFileSync(join(dir, `${path}.gz`), gz);
        written.push(path);
      }
    }
  };
  walk("");
  return written.sort();
}

/** Vite plugin: precompresses the build output once everything (the bundle, public/ and emitted assets) is written. */
export function precompress(options = {}) {
  let outDir = "dist";
  return {
    name: "phasyn:precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir); // an absolute --outDir stays absolute
    },
    closeBundle() {
      precompressDir(outDir, options);
    },
  };
}
