# Install on one machine

`install.sh` sets up Phasyn Studio on one Linux machine: it looks at your hardware, shows a plan (which features run on
which GPU), and after you agree installs everything, writes the configuration and starts the services. It never uses
`sudo`; anything that needs root is printed for you to run. AI coding agents: follow
[docs/agent-install.md](docs/agent-install.md).

## 1. Before you start

- Linux with an NVIDIA driver R580 or newer (CUDA 13.0): x86_64 with discrete GPUs (sm86 to sm120), or aarch64 with
  an sm121 unified-memory GPU (video, image vision and upscaling; Qwen-Image generation needs x86_64). Without a GPU
  you get the interface only.
- [uv](https://docs.astral.sh/uv/), git, Node.js 22.22.2 or newer with [pnpm](https://pnpm.io/), FFmpeg (with ffprobe).
  `install.sh` needs only uv to start; the plan lists anything else that is missing and how to install it.
- Disk space for the model weights: about 200 GB for video, 31 GB for images, 8 GB for image vision. The plan shows
  what is still missing and how much space is free.
- Host RAM: the plan compares it with what the video components hold in host memory (about 31 GiB for the FP8 DiT
  and its cache, about 46 GiB with every pinned budget; a GPU without FP8 needs about 20 GiB more) and says when a
  group does not fit. These are planning figures from the component settings, not measurements.

## 2. Look at the plan

```sh
git clone https://github.com/phasyn/phasyn-studio.git
cd phasyn-studio
./install.sh --dry-run
```

The dry run installs, writes and starts nothing. (It does create the checkout's own `.venv`, which the installer
needs to run.) It prints:

- your GPUs and which one is **primary** (the video and image models) and **secondary** (audio, image vision,
  upscaler);
- the route groups (`video`, `image`, `vision`, `upscale`), each `enabled` or `disabled` with the reason;
- every component and the GPU it runs on, with the reason it was chosen;
- the weights still missing, their size and **their licenses**;
- warnings (for example too little disk) and **problems** that block the install, each with a fix.

Useful options: `--routes video,upscale` (only some groups), `--models-dir /big/disk/models` (weights elsewhere; an
existing directory is reused), `--controller-port 8081 --node-port 8091` (when 8080 or 8090 is taken),
`--primary-gpu <index>`, `--data-dir <dir>` (default `~/.local/share/phasyn-studio`). A second installation on the
same machine needs its own ports, `--data-dir` and `--instance <name>` (the service name); the plan refuses to take
over another installation's services.

## 3. Install and start

```sh
./install.sh                      # asks before it changes anything
```

It syncs the Python environment, builds the web interface, builds the GPU environments the plan needs (several GB
each, a few minutes), writes the configuration to `<data-dir>/config/`, checks it with `phasyn-studio doctor`, starts
the controller and the Node as systemd user services, and brings the planned routes to ready. Run it again at any time:
finished steps are skipped, your IDs are kept, and when the configuration or the code changed (for example after
`git pull`) the running services are restarted, unless a component is busy; then the plan prints the restart command.
If your existing configuration differs from the new plan, the plan says what would change and stops; `--reconfigure`
replaces it and keeps the old files as `.bak`.

## 4. Model weights

Weights are not included. Read the licenses in the plan first. In particular, the **MiniMax H3 Community License**
does not allow use in the European Union, the United Kingdom, the Republic of Korea or the United States, and
**Qwen-Image 2.1** is licensed for non-commercial use only. Then either:

```sh
uv run phasyn-studio up --download-weights --accept-licenses    # the Node downloads the pinned files
uv run phasyn-studio up --build-sidecars                         # two small files the video models need (GPU, minutes)
```

or use **Model Weights…** on the Components page. The download is large and resumes if it is interrupted.

## 5. Use it

`up` finishes with `status: ready` and the address, normally <http://127.0.0.1:8080>. It is ready only when the Node
is online, the components of the planned routes are loaded and every planned route is ready; otherwise it lists
what is missing and the next step.

```sh
uv run phasyn-studio status              # read-only: is everything up and ready?
uv run phasyn-studio up                  # start again after a reboot and check everything
uv run phasyn-studio up --ready image    # make the image routes ready instead (one model family is loaded at a time)
journalctl --user -u phasyn-studio-node@main -f
```

Without a systemd user session (for example in a container) the install sets everything up and stops there; then
`uv run phasyn-studio up --foreground` runs both services in the terminal and Ctrl+C stops them.

Phasyn Studio has no login. Keep it on `127.0.0.1` (the default) and use an SSH tunnel to reach it from another
computer: `ssh -L 8080:127.0.0.1:8080 <your-machine>`.

## Exit codes

`0` ready, `2` invalid arguments, `3` the plan has a problem (listed), `4` a step failed (the output says which), `5`
installed but not ready or not running (next steps listed), `130` foreground services stopped with Ctrl+C after they
had been ready.
