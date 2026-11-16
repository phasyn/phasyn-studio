#!/usr/bin/env bash
# Every check that needs no GPU, in one command: format, lint, types, contracts, tests and build, plus lockfiles, file
# names that differ only in letter case, and no model weights in the tree or its history. Run it from the repository root:
#   bash tools/check.sh
# Each step prints PASS or FAIL with the tail of its output; the exit status is 1 when any step failed.
set -uo pipefail
cd "$(dirname "$0")/.."
fails=0
step() {
  local name=$1 out
  shift
  if out=$("$@" 2>&1); then
    echo "PASS $name"
  else
    echo "FAIL $name"
    echo "$out" | tail -20
    fails=$((fails + 1))
  fi
}

case_collisions() {
  # two tracked paths that are the same file on a case-insensitive file system (macOS, Windows), or the same module
  # once the extension is dropped (./name resolves to either)
  local hits
  hits=$( { git ls-files | tr '[:upper:]' '[:lower:]' | sort | uniq -d
            git ls-files | sed -E 's/\.(tsx?|jsx?|mjs|cjs)$//' | tr '[:upper:]' '[:lower:]' | sort | uniq -d; } | sort -u)
  [[ -z $hits ]] || { echo "paths that differ only in letter case:"; echo "$hits"; return 1; }
}

no_model_data() {
  # weights and data derived from model outputs never enter the repository or its history
  local pattern='\.(npz|npy|safetensors|pt|pth|ckpt|gguf|onnx)$'
  local hits
  hits=$( { git ls-files; git rev-list --all --objects | cut -d' ' -f2-; } | grep -iE "$pattern" | sort -u)
  [[ -z $hits ]] || { echo "$hits"; return 1; }
}

step "case-insensitive path collisions" case_collisions
step "no model data in tree or history" no_model_data
step "uv sync --frozen" uv sync --all-packages --frozen -q
step "ruff check" uv run --no-sync ruff check .
step "ruff format --check" uv run --no-sync ruff format --check .
step "mypy components/media/contracts" uv run --no-sync mypy packages/components/src packages/media/src tools/contracts
step "mypy server/node/controller/cli" uv run --no-sync mypy packages/server/src packages/node/src packages/controller/src packages/cli/src
step "mypy phasyn_h3" env MYPYPATH=runtimes/h3/src uv run --no-sync mypy -p phasyn_h3
step "mypy qimg/captioner" uv run --no-sync mypy runtimes/qimg/src runtimes/captioner/src
step "mypy repository tools" uv run --no-sync mypy tools/arch tools/i18n
step "openapi in sync" uv run --no-sync python tools/contracts/sync_openapi.py --check
step "error codes in sync" uv run --no-sync python tools/contracts/error_codes.py --check
step "pytest (not gpu)" uv run --no-sync pytest
step "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
step "pnpm typecheck" pnpm -r typecheck
step "pnpm lint" pnpm -r lint
step "pnpm test" pnpm -r test
step "i18n:check" pnpm --filter @phasyn-studio/frontend i18n:check
step "gen:types --check" pnpm --filter @phasyn-studio/frontend gen:types --check
step "pnpm build" pnpm -r build
step "uv lock --check" uv lock --check
for tuple in x86_64 aarch64-sm121 qimg-x86_64; do
  step "uv lock --check ($tuple)" bash -c "cd deploy/runtimes/$tuple && uv lock --check --python 3.12"
done
echo "failures: $fails"
exit $((fails > 0))
