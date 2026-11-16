#!/usr/bin/env bash
# Phasyn Studio: one-machine install for Linux.
#
#   ./install.sh --dry-run        detect this machine and show the plan; installs nothing
#   ./install.sh                  show the plan, ask, then install, configure and start
#   ./install.sh --yes --json     the same without questions, result as JSON (for scripts and AI agents)
#
# This script only checks for uv, prepares the repository's own Python environment (.venv, needed to run the
# installer) and hands over to `phasyn-studio install`, which checks everything else; every option is passed on
# (see INSTALL.md).
# It never uses sudo: commands that need root are printed for you to run.
set -euo pipefail
cd "$(dirname "$0")"

if [[ $(uname -s) != Linux ]]; then
  echo "Phasyn Studio runs on Linux only (this is $(uname -s))." >&2
  exit 3
fi

# Only uv is needed to run the installer itself. Every other prerequisite (git, Node.js, pnpm, FFmpeg) is checked by
# `phasyn-studio install`, which lists what is missing with the command to install it (also in --json).
if ! command -v uv >/dev/null 2>&1; then
  echo "missing: uv. Install it (into your home directory, no root needed), open a new shell, run ./install.sh again:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 3
fi

extra=()
if command -v nvidia-smi >/dev/null 2>&1; then
  extra=(--extra gpu) # NVML bindings for GPU sampling and doctor
fi
echo "==> Python environment (.venv in this checkout): uv sync --all-packages --frozen ${extra[*]}" >&2
uv sync --all-packages --frozen "${extra[@]}" -q
exec uv run --no-sync phasyn-studio install "$@"
