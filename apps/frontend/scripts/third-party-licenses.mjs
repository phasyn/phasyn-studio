// Third-party license notice for the production bundle (no dependencies).
// The Vite plugin below looks at the modules that actually end up in the emitted chunks, maps each node_modules
// module to its package, and emits dist/THIRD_PARTY_LICENSES.txt with every bundled package's name, version,
// license and the license text it ships (MIT / ISC / BSD require the copyright notice to travel with the code).
// A package whose license is not on the allow list fails the build, so a copyleft or unknown license never ships
// unnoticed.
// First-party files adapted from third-party code are bundled too (the shadcn/ui components, the CPython fnmatch
// port); their notices are copied from the sections of the repository's THIRD_PARTY_NOTICES.md named in
// `adapted`, and a missing section fails the build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Permissive licenses the bundle may contain without review. */
export const ALLOWED_LICENSES = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const PACKAGE_ROOT = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;

/** Package directory of a bundled module id, or null for app code and virtual modules. */
export function packageRoot(moduleId) {
  if (moduleId.startsWith("\0")) return null;
  const match = PACKAGE_ROOT.exec(moduleId.split("?")[0] ?? "");
  return match?.[1] ?? null;
}

function licenseOf(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((item) => item?.type ?? item).filter(Boolean).join(" OR ") || null;
  return null;
}

/** An SPDX expression is allowed when one alternative of an OR, or every part of an AND, is on the allow list. */
export function licenseAllowed(expression, allowed = ALLOWED_LICENSES) {
  if (!expression) return false;
  const text = expression.replace(/[()]/g, " ").trim();
  if (/\sOR\s/i.test(text)) return text.split(/\s+OR\s+/i).some((part) => licenseAllowed(part, allowed));
  if (/\sAND\s/i.test(text)) return text.split(/\s+AND\s+/i).every((part) => licenseAllowed(part, allowed));
  return allowed.has(text);
}

/** Author name only (contact details in `Name <email> (url)` are dropped). */
function authorOf(manifest) {
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  return author?.replace(/\s*[<(].*$/, "").trim() || null;
}

function repositoryOf(manifest) {
  const repo = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return (repo ?? manifest.homepage ?? "").replace(/^git\+/, "").replace(/\.git$/, "") || null;
}

/** name, version, license, repository and license texts of the package at `root`. */
export function readPackage(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = existsSync(root) ? readdirSync(root).filter((name) => LICENSE_FILE.test(name)).sort() : [];
  return {
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    author: authorOf(manifest),
    repository: repositoryOf(manifest),
    texts: files.map((name) => ({ name, text: readFileSync(join(root, name), "utf8").trim() })),
  };
}

/** The text of one `### heading` section of a Markdown file (up to the next heading of the same or a higher level). */
export function markdownSection(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const next = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start, next < 0 ? undefined : next).join("\n").trim();
}

/** The notice text: one block per package, sorted by name, then the notices of adapted first-party files. */
export function renderNotice(packages, adapted = []) {
  const rule = "-".repeat(78);
  const lines = [
    "Third-party software bundled in the Phasyn Studio web UI",
    "=".repeat(56),
    "",
    "The production build of apps/frontend includes the packages below. Each entry lists the package, its declared",
    "license and the license text it ships. Phasyn Studio itself is licensed under Apache-2.0.",
  ];
  for (const item of [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    lines.push("", rule, `${item.name} ${item.version}`, `License: ${item.license ?? "not declared"}`);
    if (item.repository) lines.push(`Source: ${item.repository}`);
    if (item.texts.length === 0) {
      lines.push("", `(The package ships no license file. Declared license: ${item.license ?? "none"}${item.author ? `; copyright holder per package.json: ${item.author}` : ""}.)`);
    }
    for (const entry of item.texts) lines.push("", `--- ${entry.name} ---`, "", entry.text);
  }
  if (adapted.length > 0) {
    lines.push("", "=".repeat(78), "Code adapted into the web UI (from THIRD_PARTY_NOTICES.md of the source repository)", "=".repeat(78));
    for (const section of adapted) lines.push("", section);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Vite plugin: emits `fileName` next to the bundle and fails the build on a license outside `allowed`.
 * `adapted` names a Markdown file and the `###` sections whose text is appended (notices of adapted code).
 */
export function thirdPartyLicenses({ fileName = "THIRD_PARTY_LICENSES.txt", allowed = ALLOWED_LICENSES, adapted = null } = {}) {
  return {
    name: "phasyn:third-party-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          const root = module.renderedLength > 0 ? packageRoot(id) : null;
          if (root) roots.add(root);
        }
      }
      const unique = new Map();
      for (const root of roots) {
        const item = readPackage(root);
        unique.set(`${item.name}@${item.version}`, item);
      }
      const packages = [...unique.values()];
      const rejected = packages.filter((item) => !licenseAllowed(item.license, allowed));
      if (rejected.length > 0) {
        this.error(`bundled packages with a license outside the allow list: ${rejected.map((item) => `${item.name}@${item.version} (${item.license ?? "none"})`).join(", ")}`);
      }
      const sections = [];
      if (adapted) {
        const markdown = readFileSync(adapted.file, "utf8");
        for (const heading of adapted.sections) {
          const section = markdownSection(markdown, heading);
          if (!section) this.error(`${adapted.file} has no section "${heading}" for the third-party notice`);
          sections.push(section);
        }
      }
      this.emitFile({ type: "asset", fileName, source: renderNotice(packages, sections) });
    },
  };
}
