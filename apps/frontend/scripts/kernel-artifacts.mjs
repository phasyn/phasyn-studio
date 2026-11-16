import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const kernelOutput = join(root, "apps/frontend/src/compute/generated/editor-kernel");
export const manifestPath = join(kernelOutput, "artifact-manifest.json");
const sources = [
  "packages/editor-kernel/Cargo.toml", "packages/editor-kernel/Cargo.lock",
  "packages/editor-kernel/rust-toolchain.toml", "packages/editor-kernel/src/lib.rs", "packages/editor-kernel/src/peaks.rs",
  "apps/frontend/scripts/build-editor-kernel.mjs", "apps/frontend/scripts/kernel-artifacts.mjs", "apps/frontend/scripts/check-editor-kernel.mjs",
];
const outputs = ["editor_kernel.js", "editor_kernel.d.ts", "editor_kernel_bg.wasm", "editor_kernel_bg.wasm.d.ts"];

function readRegular(path) {
  let parent = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    if (!lstatSync(parent).isDirectory()) throw new Error("Editor kernel artifact parent must be a real directory");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Editor kernel artifact is not a bounded regular file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** The allowlist is code-owned; a manifest cannot expand the inputs or outputs it certifies. */
export function kernelArtifactManifest() {
  const inventory = readdirSync(kernelOutput).filter((name) => name !== "artifact-manifest.json").sort();
  if (JSON.stringify(inventory) !== JSON.stringify([...outputs].sort())) throw new Error("Editor kernel artifact inventory differs; run gen:kernel");
  const digest = (path) => createHash("sha256").update(readRegular(path)).digest("hex");
  return {
    version: 1,
    sources: Object.fromEntries(sources.map((path) => [path, digest(join(root, path))])),
    outputs: Object.fromEntries(outputs.map((name) => [name, digest(join(kernelOutput, name))])),
  };
}

export function readKernelManifest() { return JSON.parse(readRegular(manifestPath).toString("utf8")); }
