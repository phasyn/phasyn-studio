# Third-party notices

Phasyn Studio is licensed under the [Apache License 2.0](LICENSE). This file lists the third-party material that
the repository contains or depends on, and the licences that apply to it. It is a factual record, not legal advice.
If you redistribute Phasyn Studio, model weights or generated media, check the original licence texts yourself.

| Material | Where it appears | Licence | Distributed in this repository |
|---|---|---|---|
| SGLang (incl. code SGLang adapted from FastVideo) | H3 runtime recipe, `runtimes/h3/` | Apache-2.0 | Adapted portions only |
| MiniMax-H3 video VAE source code (through SGLang) | H3 VAE streaming stages, `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_*.py` | Apache-2.0 (per-file SPDX identifier) | Adapted portions only; no weights |
| Hugging Face Diffusers | Qwen-Image runtime, `runtimes/qimg/` | Apache-2.0 | Adapted portions only |
| shadcn/ui | Web UI components, `apps/frontend/src/components/ui/`, `apps/frontend/src/lib/cn.ts` | MIT | Adapted portions only |
| Anime4K v4.0 (`Upscale_CNN_x2_VL`, `Restore_CNN_Soft_VL`, `Clamp_Highlights` shaders) | Video super-resolution `media.upscale`, `runtimes/captioner/src/phasyn_captioner/upscale/third_party/anime4k/` | MIT | Yes, unchanged shader files |
| CPython `fnmatch` | Web UI selector matching, `apps/frontend/src/lib/fnmatch.ts` | PSF-2.0 | Ported algorithm |
| npm packages bundled into the web UI build | `apps/frontend` production build | MIT, ISC, Apache-2.0, 0BSD | Installed at build time |
| Python, GPU and system dependencies | Control plane and GPU runtime environments | Various | No |
| Model weights and LoRA files | Loaded from the user's model directory | Model licences (see below) | No |
| AI-generated images | `apps/frontend/public/brand/`, `apps/frontend/src/assets/icons/` | Brand policy, see [] | Yes |

## 1. Code adapted into this repository

Every adapted file starts with an `SPDX-License-Identifier` line and a provenance header that names the upstream
project, revision, original file, copyright holders and what was changed. The headers are authoritative; the lists
below summarise them.

### 1.1 SGLang

- Project: <https://github.com/sgl-project/sglang>, revision `de487f8039e06853b5f376fd5f068ea9d7c400bb`
- Licence: Apache License 2.0 (the same licence as this project; full text in [LICENSE](LICENSE)). The upstream files
  carry `SPDX-License-Identifier: Apache-2.0`.
- Copyright notice of the upstream project: Copyright 2023-2024 SGLang Team.
- Used for: the MiniMax-H3 runtime recipe that drives SGLang's MiniMax-H3 pipeline.

| File in this repository | Adapted from (SGLang, `python/sglang/multimodal_gen/…`) |
|---|---|
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_streaming.py` | Temporal streaming decode of the MiniMax-H3 video VAE (`runtime/models/vaes/minimax_h3_video_vae/klvae.py`, `_decode_temporal_streaming`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_weight_streaming.py` | The fused decoder-block loop of the MiniMax-H3 video VAE, re-stated one block at a time over the tiles of a clip (`runtime/models/vaes/minimax_h3_video_vae/vae_vit.py`, `_run_fused_transformer_blocks`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_frame_streaming.py` | The MiniMax-H3 reference-video encode re-stated tile by tile and a few frames at a time (`…/minimax_h3/reference_encoding.py`, `minimax_h3_encode_reference_video_rows`; `runtime/models/vaes/minimax_h3_video_vae/klvae.py`, `encode_videos` / `encode_temporal` / `tiled_encode`; `vae_cnn.py` and `conv.py`, the encoder forwards) |
| `runtimes/h3/src/phasyn_h3/recipe/adapter/geometry.py` | Pure-Python port of the adaptive spatial resolver and the frame/length rules (`runtime/pipelines_core/stages/model_specific_stages/minimax_h3/resolved_plan.py`, `time_request.py`, `reference_encoding.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/loaders.py` | Portions of the VAE component loader (`runtime/loader/component_loaders/vae_loader.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/lora_inplace.py` | LoRA linear forward (`runtime/layers/lora/linear.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/lora.py` | LoRA pipeline helpers (`runtime/pipelines_core/lora/pipeline.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/encode_references.py` | Short portions of the MiniMax-H3 reference-encoding stage (`…/minimax_h3/reference_encoding.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/denoise_av.py` | Short portions of the MiniMax-H3 latent preparation and denoising stages (`…/minimax_h3/stages/latent_preparation.py`, `stages/denoising.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/presentation.py` | Short portions of the MiniMax-H3 conditioning presentation code (`…/minimax_h3/stages/text_encoding.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/adaln_sidecar.py` | Short portions of the MiniMax-H3 DiT time embedding and the AdaLN cache file format (`runtime/models/dits/minimax_h3.py`, `tools/build_minimax_h3_adaln_cache.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/upstream_patches.py` | Short portions of the SGLang functions it patches (`runtime/models/dits/minimax_h3.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/adapter/schedule.py` | numpy port of the shifted sigma grid (`…/minimax_h3/time_request.py`, `minimax_h3_time_shift_sigmas`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/sigmas.py` | numpy port of the per-step timestep sets and the AdaLN plan key (`…/minimax_h3/denoise_loop.py`, `runtime/models/dits/minimax_h3_adaln_cache.py`) |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/pdd.py` | numpy port of the sigma grid and block weights of the PDD head fusion (`tools/fuse_minimax_h3_pdd_heads.py`) |

#### MiniMax-H3 video VAE source (upstream of the SGLang VAE code)

The SGLang MiniMax-H3 video VAE (`runtime/models/vaes/minimax_h3_video_vae/`) is itself derived from the video VAE
source files that MiniMax publishes with the MiniMax-H3 model (<https://huggingface.co/MiniMaxAI/MiniMax-H3>, revision
`42ed227ee7df40d41602854ae760620d6eb651fe`, folders `Ref2VA/video_vae/` and `FL2VA/video_vae/`, identical files). Each
of those source files carries `SPDX-License-Identifier: Apache-2.0`; this repository uses the adapted portions under
that per-file Apache-2.0 identifier. The MiniMax-H3 *weights* and the rest of the MiniMax-H3 release are covered by
the MiniMax H3 Community License Agreement (summarised in section 3.1 below) and are not part of this repository. Original work by MiniMax.

| File in this repository | Original MiniMax function (MiniMax-H3, `Ref2VA/video_vae/…`) |
|---|---|
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_streaming.py` | `klvae.py:571` `AutoencoderKL._decode_temporal_streaming` |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_frame_streaming.py` | `klvae.py:297` `tiled_encode`, `klvae.py:461` `encode_temporal`, `klvae.py:919` `encode_videos`, `klvae.py:1231` `encode_base`; `vae_cnn.py` `EncoderFCN3D`, `ResnetBlock3D`, `Downsample3D`; `conv.py` `BaseConv3d` |
| `runtimes/h3/src/phasyn_h3/recipe/runtime/stages/vae_weight_streaming.py` | `vae_vit.py:166` `ViTBase.forward_transformer_blocks` (the decoder-block loop); `klvae.py:278` `AutoencoderKL._run_tile_tasks` |

### 1.2 FastVideo (through SGLang)

SGLang marks some of its LoRA code (`runtime/layers/lora/linear.py`, `runtime/pipelines_core/lora/pipeline.py`) as
"Copied and adapted from: https://github.com/hao-ai-lab/FastVideo". The portions of those files that this repository
adapted therefore also originate from FastVideo, which is distributed under the Apache License 2.0.

### 1.3 Hugging Face Diffusers

- Project: <https://github.com/huggingface/diffusers>, revision `578c9b2c6636ab2424a0e56186268b83623656b2`
- Licence: Apache License 2.0
- Copyright notices of the upstream files:
  - `src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py`: Copyright 2026 Qwen-Image Team, The HuggingFace
    Team. All rights reserved.
  - `src/diffusers/schedulers/scheduling_flow_match_euler_discrete.py`: Copyright 2025 Stability AI, Katherine Crowson
    and The HuggingFace Team. All rights reserved.
  - `src/diffusers/image_processor.py`: Copyright 2026 The HuggingFace Team. All rights reserved.
- Used for: the Qwen-Image 2.1 runtime, which re-implements the pipeline as separate components.

| File in this repository | Adapted from (Diffusers) |
|---|---|
| `runtimes/qimg/src/phasyn_qimg/conditioning.py` | Prompt encoding path of `QwenImage21Pipeline` (`pipeline_qwenimage21.py`) |
| `runtimes/qimg/src/phasyn_qimg/vae.py` | Latent normalisation and the VAE encode/decode paths of `QwenImage21Pipeline` (`_encode_vae_image`, decode in `__call__`); pre- and post-processing of `VaeImageProcessor` (`image_processor.py`) |
| `runtimes/qimg/src/phasyn_qimg/latents.py` | Packed latent layout of `QwenImage21Pipeline` (`_pack_latents`, `_unpack_latents`) |
| `runtimes/qimg/src/phasyn_qimg/dit/driver.py` | Denoising loop of `QwenImage21Pipeline.__call__` and the flow-matching Euler step |
| `runtimes/qimg/src/phasyn_qimg/dit/schedule.py` | Sigma schedule of `FlowMatchEulerDiscreteScheduler` (`scheduling_flow_match_euler_discrete.py`) and `calculate_shift` (`pipeline_qwenimage21.py`) |
| `runtimes/qimg/src/phasyn_qimg/prepare.py` | Short portions of `QwenImage21Pipeline`: `calculate_dimensions` and the white-matte reference conversion |

### Anime4K

- Project: <https://github.com/bloc97/Anime4K> (v4.0.1 release, asset `Anime4K_v4.0.zip`)
- Licence: MIT
- Used for: the `media.upscale` provider runs the `Anime4K_Upscale_CNN_x2_VL.glsl` shader's convolution weights in
  PyTorch, and its optional sharper method adds `Anime4K_Clamp_Highlights.glsl` and `Anime4K_Restore_CNN_Soft_VL.glsl`;
  the shader files are vendored unchanged with their licence and each sha256 is checked at load.

```text
MIT License

Copyright (c) 2019-2021 bloc97
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The notice above is the header carried by the vendored shader files; the upstream repository LICENSE reads
"Copyright (c) 2019 bloc97" with the same MIT terms.

### 1.4 shadcn/ui

- Project: <https://github.com/shadcn-ui/ui>
- Licence: MIT
- Used for: `apps/frontend/src/components/ui/dialog.tsx` follows the shadcn/ui Dialog and Sheet components (new-york
  registry; Radix primitives, `forwardRef` wrappers) and was restyled for this project; other files in
  `apps/frontend/src/components/ui/` and the `cn()` class-name helper (`apps/frontend/src/lib/cn.ts`) follow shadcn/ui
  conventions.

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.5 CPython `fnmatch`

- Project: <https://github.com/python/cpython>, `Lib/fnmatch.py` (3.12 series)
- Licence: Python Software Foundation License Version 2
- Used for: `apps/frontend/src/lib/fnmatch.ts` lets the web UI preview which sub-part paths a selector matches, with
  the same semantics as the Node's `fnmatch.fnmatchcase`.
- Summary of changes (PSF licence, clause 3): the pattern-to-regular-expression translation of `fnmatch.translate` was
  re-implemented in TypeScript for case-sensitive matching only; an invalid character range raises an error instead
  of producing a pattern; no other part of CPython is included.

```text
PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.
```

## 2. Dependencies installed at build or run time

These are not vendored. They are downloaded by `uv`, `pnpm` or the system package manager, and each keeps its own
licence.

- **Web UI build.** The production build bundles npm packages: React and React DOM, React Router, TanStack Query,
  Radix UI Dialog, three.js, React Three Fiber, Motion, Lucide (ISC), class-variance-authority (Apache-2.0), clsx,
  tailwind-merge and what they depend on. The build writes the name, version, licence and licence text of every
  package that ends up in the bundle to `THIRD_PARTY_LICENSES.txt` next to it, and fails on a licence outside
  MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause and 0BSD. At the 1.0.0 audit the bundle held 45 packages:
  42 MIT, 1 Apache-2.0, 1 ISC, 1 0BSD. For the revision you are building, read that file or run
  `pnpm licenses list --prod` in `apps/frontend`.
- **Control plane (controller, node, CPU components).** Python packages from PyPI under permissive licences, plus
  `certifi` (MPL-2.0), which is used unmodified as a package.
- **GPU runtime environments** (`deploy/runtimes/*`). These environments install PyTorch, SGLang, Diffusers,
  Transformers and their dependencies, including NVIDIA CUDA wheels under NVIDIA's proprietary licence terms, a few
  LGPL or MPL packages used unmodified (for example `tqdm`, `easydict`, `pycountry`), and wheels that bundle FFmpeg
  builds or libraries which may include GPL-licensed parts: PyAV, OpenCV, `imageio-ffmpeg` (a prebuilt FFmpeg
  executable) and, on aarch64, `decord2`. This repository does not redistribute any of them. If you build and
  distribute container images or other bundles that contain these environments, review those licences for that
  distribution.
- **FFmpeg and ffprobe** are expected on the system path. FFmpeg is licensed under the LGPL 2.1 or later, or under
  the GPL when the build enables GPL parts, so the licence that applies is the one of the build you install.

## 3. Model weights and LoRA files (not distributed)

Phasyn Studio does not include or redistribute model weights or LoRA files, and it never downloads them on its own. You
obtain them from their publishers and accept their licences — by hand, or by asking a Node to download the pinned files
a component needs from the publisher's Hugging Face repository (Components page → **Model Weights**, which shows each
licence and downloads only after you accept it) — and point component settings at your model directory. Phasyn Studio
is self-hosted software; the project does not operate a hosted generation service.

The repository ships small LoRA *metadata* manifests in `runtimes/h3/src/phasyn_h3/loras/` (names, file sizes,
hashes, compatible variants and licence links) and pinned file lists of the MiniMax-H3, Qwen-Image 2.1 and
Qwen3-VL-4B-Instruct snapshots in `runtimes/*/src/*/weight_manifests/` (paths, sizes and hashes). They describe
third-party files and contain no weights. It contains
no MiniMax H3 Materials either: the H3 runtime reads the official configuration files from your own MiniMax-H3
snapshot and checks them against pinned SHA-256 values.

| Model or LoRA | Used by | Licence | Key terms to check |
|---|---|---|---|
| [MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) (FL2VA and Ref2VA variants, text encoder, VAEs) | H3 video components | MiniMax H3 Community License Agreement (August 2, 2026) | See 3.1 |
| [Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1), including its text encoder | Image Studio (`qimg.*` components) | Qwen Research License Agreement (September 20, 2026) | Non-commercial use only; see 3.2 |
| GGUF conversions of Qwen-Image (user-supplied) | Optional `qimg.dit` GGUF variant | Base model licence plus the publisher's terms | No conversion is configured or recommended by default |
| [Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) | `qimg.vision` (prompt reconstruction) | Apache-2.0 | — |
| Qwen-VL family checkpoints chosen by the user | `qwen_vl.describe` (video understanding) | Depends on the checkpoint | Check the model card of the checkpoint you use. The example configuration for a second machine points this component at the text encoder of your MiniMax-H3 snapshot: those files are part of MiniMax-H3, so the MiniMax H3 Community License applies to them (see 3.1) |
| [lightx2v Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) LoRAs | H3 DiT acceleration | Apache-2.0 in the publisher's [source repository](https://github.com/ModelTC/Minimax-H3-Turbo); the model card names no licence of its own and refers to the repository licence (checked 2026-11-10) | As Model Derivatives of MiniMax-H3 they also come under the MiniMax H3 Community License (territory, §V.3, Acceptable Use Policy; see 3.1) |
| [alibaba-pai MiniMax-H3-Acc-LoRAs](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs) | H3 DiT acceleration | MiniMax H3 Community License Agreement | Same terms as MiniMax-H3 |

### 3.1 MiniMax H3 Community License — points to know

- **No training of other models (§V.3).** The MiniMax H3 Works (weights, Model Derivatives such as LoRAs) and their
  outputs or results may be used to improve only MiniMax H3 and its Model Derivatives. This includes datasets,
  captions, scores, features or weights derived from H3 outputs, and applies to internal and research use as well.
- **Territory (§V.4, AUP item 1).** The licence covers worldwide use except the European Union, the United Kingdom,
  the Republic of Korea and the United States of America. Using, reproducing, modifying, distributing or displaying
  the weights **or their outputs** in those territories needs a separate licence from MiniMax (§II; application form
  linked from the model card).
- **Acceptable Use Policy** (Exhibit A of the licence). Among other things it prohibits impersonating another person
  without that person's consent, authorisation or lawful right (item 13), and publishing machine-generated content in
  public environments without clearly disclosing that it is machine-generated (item 12).
- **Redistribution** of MiniMax H3 Works (weights, documentation, model derivatives) requires giving recipients a copy
  of the licence, marking modified files, and including a `NOTICE` text file with this sentence:
  "MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights
  Reserved."
- **Providing access to others.** Anyone who makes a product or service built on MiniMax H3 available to other people
  must bind those users to the use restrictions and maintain safeguards against prohibited uses and outputs (section V).
- **Encouraged, not required** (section III.3): a "Powered by MiniMax H3" notice on products built with it, and an
  AI-generation identifier in generated files.
- **Commercial use.** Commercial products or services with more than 20 million US dollars of yearly revenue need a
  separate written authorisation from MiniMax, and commercial products must display "MiniMax H3" in their user
  interface (section IV).
- The licence notes that the MiniMax-H3 text encoder is based on Qwen3-VL-32B, licensed under Apache-2.0.

### 3.2 Qwen Research License — points to know

- **Non-commercial only.** The Qwen-Image 2.1 materials may be used, modified and redistributed for research or
  evaluation purposes only; commercial use requires a separate licence from the publisher. Treat Image Studio as a
  research and evaluation feature unless you hold such a licence.
- **Redistribution** requires giving recipients a copy of the agreement, marking modified files, and keeping this
  attribution in a "Notice" text file: "Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c)
  2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved."

## 4. AI-generated images

The following 24 image files were generated with OpenAI Codex image generation (the Codex CLI image route; the tool
did not report the model version). Each image was generated once and then only resized and converted (for example
to 256 × 256 RGBA PNG or to WebP). They are brand assets: they are covered by the brand policy in
[], not by the Apache License.

- Component-type icons (5): `apps/frontend/src/assets/icons/kind-{text-condition,dit-denoise,video-decode,audio-decode,media-mux}-v1.png`
- Workspace area icons (10): `apps/frontend/public/brand/areas/{components,image,inference,records,video}.webp` and
  their `@2x` variants
- Empty-state illustrations (8): `apps/frontend/public/brand/illustrations/{drop,frames,offline,timeline}.webp` and
  their `@2x` variants
- Background (1): `apps/frontend/public/brand/backgrounds/aurora.webp`

The Phasyn logo files (`apps/frontend/public/brand/mark-*`, `icon-*`, `og-1200x630.jpg`) and the SVG wordmark are not
AI-generated; they are brand assets covered by [].

## 5. Fonts

No font files are bundled. The web UI uses the operating system's font stacks.
