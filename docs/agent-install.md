# Installing Phasyn Studio: a guide for AI coding agents

This page is for an AI agent that installs Phasyn Studio on the machine it works on, on behalf of a user. It covers
one machine (one Controller and one Node). People should read [INSTALL.md](../INSTALL.md) instead.

Everything below uses two entry points that ship in the repository: `./install.sh` (checks for uv, prepares the
checkout's `.venv`, then runs `phasyn-studio install`) and the `phasyn-studio` command (`uv run phasyn-studio …` from
the checkout). Always pass `--json`: the JSON document is the only thing on stdout; progress goes to stderr.

## Rules

- **Never run `sudo` or install system packages yourself.** A problem with `needs_root: true` comes with the command;
  show it to the user and wait until they ran it.
- **Never accept a license for the user.** `--accept-licenses` means the user read and accepted every license in
  `weights.sets[].license`. Show the names, links and notes, and ask. The MiniMax H3 Community License excludes the
  European Union, the United Kingdom, the Republic of Korea and the United States, and restricts using outputs to
  improve other models; Qwen-Image 2.1 is non-commercial only.
- **Never stop, replace or reconfigure something you did not start.** A port or a systemd unit held by another program
  or another installation is the user's: propose the alternative from the problem's `fix`, do not kill the process.
- **Do not pass `--replace-dit`** unless the user agreed to unload the DiT that is loaded.
- Do not edit the repository's templates (`deploy/config/*.example.json`, `examples/`), and never run
  `uv lock --upgrade` or `uv add` in `deploy/runtimes/*` (the GPU environments are pinned on purpose).
- Do not invent settings. If the plan disables a group, report its `reasons`; do not edit the generated configuration
  to force it.
- **To read the state, use `uv run phasyn-studio status --json`.** It only sends GET requests. `install` and `up` change
  things (they start services, create pipelines, load models); never repeat one of them just to look. A command that
  timed out may still have worked: read the state with `status` before you repeat anything.

## Step 1: the plan (read-only)

```sh
./install.sh --dry-run --json > /tmp/phasyn-plan.json   # exit 0: no problems; exit 3: problems to resolve
```

It takes a few seconds once `.venv` exists. Nothing is installed, written or started; only the checkout's `.venv` is
created if it was missing (the installer runs from it). Fields to read:

| Field | Meaning |
|---|---|
| `ok` | `false` when `problems` is not empty; the install refuses to run then |
| `problems[]` | `{id, message, fix, needs_root}`; `id` is one of `UNSUPPORTED_OS`, `UNSUPPORTED_ARCH`, `MISSING_UV`, `MISSING_GIT`, `MISSING_NODE`, `OLD_NODE`, `MISSING_PNPM`, `OLD_PNPM`, `MISSING_FFMPEG`, `MISSING_FFPROBE`, `PORT_IN_USE`, `UNIT_IN_USE`, `UNKNOWN_GPU`, `NO_SYSTEMD_USER`, `CONFIG_INVALID`, `CONFIG_DIFFERS` |
| `warnings[]` | Not blocking: too little disk for the weights, little host RAM, an untested GPU size or layout, an old driver (GPU groups then disabled) |
| `profile` | `dual-gpu`, `single-gpu`, `no-gpu` or `uma` (aarch64 with an sm121 unified-memory GPU: GPU and CPU share host RAM, components run on the `aarch64-sm121` runtime, Qwen-Image generation is disabled) |
| `gpus[]` | Each GPU with `role` (`primary`, `secondary`, `unused`) and `reason` when unused |
| `groups.{video,image,vision,upscale}` | `status` (`enabled`, `disabled`, `not_requested`), `reasons`, `warnings`, `pipelines` |
| `components[]` | Every GPU component: `component_id`, `gpu_index`, `why`, `choices` |
| `ready_routes` | The pipelines `up` loads and requires to be ready (one DiT's routes; a Node keeps one DiT loaded) |
| `standby_routes` | Configured pipelines that load on demand (for example the other DiT) |
| `weights` | `sets[]` (`label`, `repo`, `revision`, `license {name, url, note}`, `bytes_total`, `bytes_missing`), `missing_gib`, `models_free_gib`, `fits` |
| `sidecars[]` | AdaLN sidecar files the video DiTs need (`present`) |
| `services` | `mode` (`systemd` or `foreground`), `instance`, ports, URLs, unit names, config paths |
| `config_changes` | What a re-run would change in an existing configuration |
| `rules[]` | The placement rules (planning heuristics, not measurements) and their basis |
| `web_ui` | The address to give the user |

## Step 2: decisions with the user

Resolve every problem before installing, and ask the user about each of these:

1. **Problems with `needs_root: true`**: show `fix`; continue after the user ran it (repeat Step 1).
2. **`PORT_IN_USE` or `UNIT_IN_USE`**: another installation or program holds the port or the service name. Offer the
   options from `fix` (`--controller-port`, `--node-port`; for a second installation also `--instance <name>` and
   `--data-dir <dir>`), or let the user free it.
3. **`CONFIG_DIFFERS`**: an earlier installation in the same data directory has other settings. Show
   `config_changes`; pass `--reconfigure` only if the user wants them replaced (the old files are kept as `.bak`).
4. **`weights.fits` is `false`**: ask for a larger disk (`--models-dir <dir>`; an existing model directory is reused
   and counted as present) or fewer groups (`--routes image,upscale`).
5. **Disabled groups**: tell the user which and why (`groups.<name>.reasons`).
6. **Licenses**: show every entry of `weights.sets[]` with `bytes_missing > 0` and ask whether the user accepts.

Repeat Step 1 with the chosen options until `ok` is `true` and the user agrees with the plan.

## Step 3: install

Use the same options as the accepted plan:

```sh
./install.sh --yes --json [--routes …] [--models-dir …] [--controller-port …] [--node-port …] > /tmp/phasyn-install.json
```

This runs for a long time (Python environment, web UI build, one GPU environment per entry of `runtimes[]`, several
GB each). Run it in the background and wait for it to exit; do not start it twice. It always exits; it never keeps
services in the foreground.

| Exit | stdout (`--json`) | Meaning | What to do |
|---|---|---|---|
| `0` | `{plan_file, report}`, `report.status` `ready` | Ready | Give the user `web_ui` |
| `2` | nothing | Invalid arguments (the `error:` line on stderr says which) | Fix the arguments |
| `3` | the plan | The plan has problems | Back to Step 2 |
| `4` | nothing, or `{plan_file, report}` with `status` `failed` | A step failed (the `error:` line on stderr names it), or the services did not come up | Fix it and run the same command again; finished steps are skipped |
| `5` | `{plan_file, report}`, `report.status` `not_ready` or `not_started` | Installed, not ready | Read `report.next_steps` |

A first install normally ends with `5` because no weights are present yet. `report` holds `status`, `routes`
(per pipeline: `ready`, `problems`, `target`), `components` (`state`, `error`), `weights`, `sidecars`, `next_steps`
and `errors`.

Re-running the install applies a changed configuration or checkout: this installation's running services are
restarted, unless a component is busy; then `next_steps` gives the restart command to run later.

**Without a systemd user session** (`services.mode` is `foreground`, for example in a container) the install ends with
`status` `not_started` and exit `5`. Start the services in the background and poll the read-only status:

```sh
nohup uv run phasyn-studio up --foreground --data-dir <data_dir> > <data_dir>/services.log 2>&1 &
uv run phasyn-studio status --json --data-dir <data_dir>      # repeat until report.status is ready (or read the log)
```

`up --foreground` stops the services and exits `4` when they do not come up. Stopped with Ctrl+C (SIGINT), it exits
`130` if the routes had been ready and `5` if not; the services stop with it.

## Step 4: weights and sidecars (only with the user's acceptance)

```sh
uv run phasyn-studio up --json --download-weights --accept-licenses   # the Node downloads the pinned files
uv run phasyn-studio up --json --build-sidecars                        # builds the AdaLN sidecars on the primary GPU
```

The download is large (about 240 GiB for every group), resumes after an interruption and is never retried on its own;
run it in the background. If the user put the weights in place by hand, skip the download. Sidecars are built only
when every weight is present. With foreground services, run these while `up --foreground` is running; they then
only talk to the running services.

## Step 5: verify

```sh
uv run phasyn-studio status --json
```

Done means `report.status == "ready"` (exit `0`): the controller answers with this installation's id, the Node is
online, every component of `ready_routes` is started and every one of those routes is ready. Process exit codes of the
services alone do not count. `status` reports `down` (exit `5`) when no controller answers and `failed` (exit `4`) when
another installation answers on the port. For the environment itself, the existing read-only check:

```sh
uv run phasyn-studio doctor --config <config_dir>/node.json   # JSON; "ok" and "problems"
```

To make other routes ready (for example images while video is loaded): `uv run phasyn-studio up --json --ready image`.
A group stands for the routes of one DiT; routes that need two different DiTs are refused. The Node asks before it
replaces a loaded DiT; that needs `--replace-dit` and the user's consent.

## Failures and fixes

| Seen | Fix |
|---|---|
| `NODE_NOT_ONLINE` | The Node did not register: `journalctl --user -u phasyn-studio-node@<instance> -n 100` (or the foreground log) |
| `WRONG_CONTROLLER` | Another installation answers on the controller port: use other ports (Step 2) |
| `COMPONENT_NOT_CONFIGURED` | Weights missing (Step 4) |
| `ADALN_SIDECAR_MISSING` | `up --build-sidecars` after the weights |
| `PROVIDER_NOT_INSTALLED`, `UPSTREAM_PATCH_SOURCE_MISMATCH` | A GPU environment is missing or out of date: run the install again |
| `GPU_MEMORY_INSUFFICIENT`, `HOST_MEMORY_INSUFFICIENT` | Something else holds the memory; ask the user before stopping anything |
| `EXCLUSIVE_GROUP_CONFLICT` | Another DiT is loaded; ask the user, then `--replace-dit` |
| `LOAD_TIMEOUT` | Read the component's log in `<data_dir>/node/logs/components/<component_id>/` |
| `pipeline … could not be created` | Read the error; the route stays not ready until the pipeline exists |
| A `.venv` or `pnpm` step fails | Read the output on stderr; the steps need network access to the package registries |

## After the install

- Create Studio projects and images only after `status` reports the routes ready. An image or project created while
  no suitable route is ready is saved with the placeholder route `unassigned`, and its renders stay blocked until a
  route is chosen for it.
- Keep the services on `127.0.0.1`. Phasyn Studio has no login; for remote use, an SSH tunnel.
