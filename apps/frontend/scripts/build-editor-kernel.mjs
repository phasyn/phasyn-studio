// Build only; acquisition is a separate, explicitly prepared local operation.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kernelArtifactManifest, manifestPath } from "./kernel-artifacts.mjs";

const crate = fileURLToPath(new URL("../../../packages/editor-kernel/", import.meta.url));
const output = fileURLToPath(new URL("../src/compute/generated/editor-kernel/", import.meta.url));
const cargo = process.env.PHASYN_CARGO ?? "cargo";
const rustc = process.env.PHASYN_RUSTC ?? "rustc";
const bindgen = process.env.PHASYN_WASM_BINDGEN ?? "wasm-bindgen";
const run = (program, args, capture = false) => execFileSync(program, args, {
  cwd: crate, timeout: 180000, stdio: capture ? "pipe" : "inherit", encoding: "utf8", env: { ...process.env, RUSTC: rustc },
});
const toolchain = readFileSync(`${crate}rust-toolchain.toml`, "utf8");
const compilerPin = /^channel = "([^"\n]+)"$/m.exec(toolchain)?.[1];
if (!compilerPin || !run(rustc, ["--version"], true).startsWith(`rustc ${compilerPin} `)) throw new Error("Rust compiler must match editor-kernel/rust-toolchain.toml");
const manifest = readFileSync(`${crate}Cargo.toml`, "utf8");
const expected = /^wasm-bindgen\s*=\s*"=([^"\n]+)"$/m.exec(manifest)?.[1];
if (!expected) throw new Error("editor-kernel requires an exact wasm-bindgen dependency pin");
const lock = readFileSync(`${crate}Cargo.lock`, "utf8");
const locked = lock.split("[[package]]").find((entry) => /^name = "wasm-bindgen"$/m.test(entry));
const lockVersion = locked && /^version = "([^"\n]+)"$/m.exec(locked)?.[1];
const cliVersion = /^wasm-bindgen ([^\s]+)\s*$/.exec(run(bindgen, ["--version"], true))?.[1];
if (expected !== lockVersion || expected !== cliVersion) throw new Error("wasm-bindgen manifest, Cargo.lock and CLI versions must match exactly");
run(cargo, ["build", "--locked", "--offline", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", `${crate}target`]);
mkdirSync(output, { recursive: true });
run(bindgen, [`${crate}target/wasm32-unknown-unknown/release/phasyn_editor_kernel.wasm`, "--target", "web", "--out-name", "editor_kernel", "--out-dir", output]);
writeFileSync(manifestPath, `${JSON.stringify(kernelArtifactManifest(), null, 2)}\n`, "utf8");
