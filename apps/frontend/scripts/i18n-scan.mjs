// i18n scanning core, shared by i18n-extract (dry run), i18n-codemod (--apply) and i18n-check. It uses only the repo's
// existing typescript devDependency (compiler API, no type checking) to find user-visible CJK strings in the frontend
// and decide by syntactic position: wrap (the codemod wraps it in t()), skip (types, object keys, comparison operands,
// console…) or review (a human decides). The rules live in one place, so a dry run and --apply always agree.
// The implementation is split by concern under scripts/i18n/; this module is the public entry.
export { i18nAliases } from "./i18n/ast.mjs";
export { APP_ROOT, CJK_RE, CONTEXT_SEPARATOR, HAN_RE, LIST_SEPARATORS, regexLike, SRC_ROOT, ts } from "./i18n/core.mjs";
export { AREAS, areaOf, bundledFiles, listSourceFiles, OVERRIDES } from "./i18n/files.mjs";
export { scanFile, scanSource } from "./i18n/scan.mjs";
export { jsxTextValue, placeholderNames, placeholdersIn, pluralHint } from "./i18n/text.mjs";
