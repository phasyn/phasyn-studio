# Installation

Phasyn Studio runs from a checkout of this repository: one **Controller** (web interface and API) and one **Node** per
machine that has GPUs. These steps install both on one Linux machine.

**Quicker:** `./install.sh --dry-run` shows a plan for this machine and `./install.sh` carries out the steps below for
you, with the configuration in `~/.local/share/phasyn-studio` instead of `deploy/config/` (see
[INSTALL.md](../INSTALL.md); AI coding agents follow [agent-install.md](agent-install.md)).

## 1. Requirements

- **Linux** (x86_64; aarch64 for machines with unified-memory GPUs).
- **NVIDIA driver with CUDA 13.0 support** (R580 or newer). Supported: discrete GPUs from sm86 to sm120 on x86_64 and
  sm121 unified-memory GPUs on aarch64. FP8 models need compute capability 8.9 or newer; BF16 runs on every supported
  GPU. The INT8 models also need a CUDA toolkit (`nvcc`) and `ninja`.
- **Memory:** plan host RAM above the size of the video model you load, and keep the weights on fast local storage.
- **Python 3.12** with [uv](https://docs.astral.sh/uv/), **Node.js 22.22.2 or newer** with [pnpm](https://pnpm.io/) 12,
  **git**, and **FFmpeg and ffprobe** on `PATH`.

## 2. Install

```sh
git clone https://github.com/phasyn/phasyn-studio.git
cd phasyn-studio
uv sync --all-packages --frozen --extra gpu    # without an NVIDIA GPU leave out --extra gpu
pnpm install --frozen-lockfile
pnpm build                                     # the web interface
```

Then build the GPU environments you need (each takes a few minutes and several GB):

```sh
cd deploy/runtimes/x86_64                      # video (MiniMax-H3); qimg-x86_64 for images; aarch64-sm121 on aarch64
SGLANG_BUILD_RUST_EXTS=none uv sync --frozen --python 3.12
CUDA_VISIBLE_DEVICES= .venv/bin/phasyn-h3-importcheck --pins    # x86_64 and aarch64-sm121: checks the install
.venv/bin/python -m phasyn_components.runtime_host --list       # any environment: lists what it provides
cd ../../..
```

Never upgrade these environments with `uv lock --upgrade` or `uv add`; they are pinned on purpose.

## 3. Configure

```sh
cp deploy/config/controller.example.json deploy/config/controller.json
cp deploy/config/node-a.example.json     deploy/config/node-a.json
```

Edit the copies:

- `instance_id` (controller) and `node_id` (node): a fresh UUID each, for example from `uuidgen`.
- `load.model_path` of every GPU component: your models directory (section 4).
- `device.id` of every GPU component: the GPU UUID from `nvidia-smi -L`, replacing `GPU-REPLACE-0` (first GPU) and
  `GPU-REPLACE-1` (second GPU). With one GPU, give both the same UUID and resource group.

Check the result (it changes nothing; `problems` lists anything still left from the templates):

```sh
uv run phasyn-studio doctor --config "$PWD/deploy/config/node-a.json"
```

## 4. Model weights

Weights are not included. Either put them in your models directory yourself, or start Phasyn Studio (section 5), open
the **Components** page, select a GPU component and choose **Model Weights…**: after you accept the licenses shown, the
node downloads the exact files the component needs from Hugging Face (public repositories need no token; for a gated
copy set `HF_TOKEN` for the node).

| Files | Source |
|---|---|
| `MiniMax-H3/FL2VA/`, `MiniMax-H3/Ref2VA/` | [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| `loras/alibaba-pai-acc/…` | [alibaba-pai/MiniMax-H3-Acc-LoRAs](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs) |
| `qwen-image-2.1/` | [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) |
| `Qwen3-VL-4B-Instruct/` | [Qwen/Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) |

Read each license before you use the model; see the README and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## 5. Start

```sh
uv run phasyn-studio controller --config "$PWD/deploy/config/controller.json"
uv run phasyn-studio node --config "$PWD/deploy/config/node-a.json"      # in a second terminal
```

Open <http://127.0.0.1:8080>. To use it from another computer, forward the port instead of exposing it:
`ssh -L 8080:127.0.0.1:8080 <your-machine>`. Phasyn Studio has no login; keep it on `127.0.0.1` or a network you
trust.

To keep the services running, install them as systemd user services:

```sh
uv run phasyn-studio service install --role controller --instance main \
    --config "$PWD/deploy/config/controller.json" --start --enable
uv run phasyn-studio service install --role node --instance main \
    --config "$PWD/deploy/config/node-a.json" --start --enable
```

### Without a GPU

The interface also starts without a GPU, but nothing can be generated. Leave the GPU parts of the copies as they are;
the node then logs that the GPU environments cannot run, which you can ignore.

## 6. Your first video

1. **Weights:** with **Model Weights…**, download what `te-gpu0` and `dit-fl2va-fp8-pai8` need (section 4).
2. **Two small files the example video models need**, built once on the GPU that will run them (stop the components
   first):

   ```sh
   cd deploy/runtimes/x86_64
   .venv/bin/phasyn-h3-adaln-sidecar --variant fl2va --task-shape t2va --task-shape fl2va \
       --steps 8 --video-shift 12 --audio-shift 3 \
       --transformer-path <models-dir>/MiniMax-H3/FL2VA/transformer --model-root <models-dir> \
       --lora-manifest ../../../runtimes/h3/src/phasyn_h3/loras/pai-h3-fl2va-acc8.json \
       --output <models-dir>/adaln-cache/h3-fl2va-pdd8.safetensors
   .venv/bin/phasyn-h3-adaln-sidecar --variant ref2va \
       --task-shape ref2va-image --task-shape ref2va-audio --task-shape ref2va-mixed \
       --steps 8 --video-shift 12 --audio-shift 3 \
       --transformer-path <models-dir>/MiniMax-H3/Ref2VA/transformer --model-root <models-dir> \
       --lora-manifest ../../../runtimes/h3/src/phasyn_h3/loras/pai-h3-ref2va-acc8.json \
       --output <models-dir>/adaln-cache/h3-ref2va-pdd8.safetensors
   ```

3. **A pipeline:** on the Components page open **Pipelines**, choose **New from Template** and
   *Generation: TE→DiT→Final Decode*, pick your components and save.
4. **Start the components** the pipeline uses; in Video Studio, **Render Engine** shows what is still missing and can
   start it.
5. **Render:** in Video Studio create a project, add a shot, write a prompt and choose **Render Shot**.

## 7. Upgrading

```sh
git pull
uv sync --all-packages --frozen --extra gpu
pnpm install --frozen-lockfile && pnpm build
(cd deploy/runtimes/x86_64 && SGLANG_BUILD_RUST_EXTS=none uv sync --frozen --python 3.12)   # each environment you use
```

Then restart the services.

## 8. Optional components

Each optional component adds one tool to the Studio. Install only the ones you want:

1. Create its own environment from the lock in its runtime folder, from the repository root. A folder with a
   `uv.lock` is one command, for example `uv sync --project deploy/runtimes/speech --frozen --python 3.12`. A folder
   with `requirements*.lock` files adds those hash-pinned packages (`uv pip install --require-hashes -r …`) on top of
   a new copy of the base environment its `base.sha256` names (when the folder has one); then install the component package from
   `runtimes/<name>/` into the same environment. Restoration and frame interpolation already run in the video
   environment; never install the others into it.
2. Add the folder's `runtime.example.json` to the Node's `runtimes` (adjust the Python path) and restart the Node.
3. Download the weights from the model page (or with **Model Weights…** on the Components page), then add the
   component from `examples/components/` and the matching pipeline from `examples/pipelines/`.

| Component | What it adds | Runs on | Runtime folder | Model |
|---|---|---|---|---|
| Wan VACE | retake part of a shot, fill a gap, extend a shot, generate from a pose/depth/edge guide | NVIDIA GPU (the publisher states 8.19 GB VRAM for the related 1.3B text-to-video model) | `deploy/runtimes/wan-edit-x86_64` | [Wan2.1-VACE-1.3B](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B-diffusers) |
| Wan speech and performance | a character speaking a recorded line; a character copying a performance clip | large-memory NVIDIA GPU (the publisher states at least 80 GB VRAM for single-GPU speech-to-video with offloading) | `deploy/runtimes/wan-native` | [Wan2.2-S2V-14B](https://huggingface.co/Wan-AI/Wan2.2-S2V-14B), [Wan2.2-Animate-14B](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B) |
| Object masks | click a person or object and get a mask for every frame | NVIDIA GPU | `deploy/runtimes/segmentation` | [SAM 2.1 hiera-tiny](https://huggingface.co/facebook/sam2.1-hiera-tiny) |
| Dubbing | speak a line with a built-in voice | CPU or NVIDIA GPU | `deploy/runtimes/speech` | [Qwen3-TTS CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) |
| Transcription | turn the dialogue of a clip into captions | CPU or NVIDIA GPU | `deploy/runtimes/transcription` | [faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) |
| Pose, depth and performance controls | skeleton, depth and person masks from a clip; move a portrait or a character image | CPU | `deploy/runtimes/performance-cpu` | MediaPipe [pose](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Full) and [face](https://huggingface.co/litert-community/MediaPipe-FaceLandmarker) landmarkers, [MiDaS v2.1](https://github.com/isl-org/MiDaS) |
| Restoration and frame interpolation | restore blurry or noisy takes; smoother motion | NVIDIA GPU | `deploy/runtimes/x86_64` (already installed for video) | [SeedVR2-3B](https://huggingface.co/ByteDance-Seed/SeedVR2-3B), [Practical-RIFE 4.26](https://github.com/hzwer/Practical-RIFE) |
| Art exchange | hand a frame to Krita or Blender and bring the painted revision back | CPU | `deploy/runtimes/art-exchange` | none; the Krita add-on is in `plugins/krita/` |

The licences of these models are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); the weights are not
included in this repository.
