"""``qimg.dit``: the Qwen-Image 2.1 DiT component (own denoise driver, placement, adapters, previews).

Modules (heavy imports are deferred into functions; describe() and the settings checks are torch-free):

- ``options``    settings/parameter schema, defaults and semantic checks (variant × placement, paths, ABI)
- ``describe``   describe(): availability (modules, pinned diffusers, model files), ports and parts
- ``inputs``     consistency of conditioning/reference latents with the call parameters (422, never reshaped)
- ``schedule``   FlowMatch Euler schedule (numpy; bit-identical to diffusers)
- ``admission``  VRAM/RAM admission estimates (available VRAM from ``phasyn_qimg.memory``)
- ``driver``     the denoise loop (reproduces the QwenImage21Pipeline denoise path)
- ``loading``    BF16/override/GGUF transformer, LoRA/slider adapters, path-free model identity
- ``placement``  phase / group_stream / none / gguf_phase
- ``preview``    vae_thumbnail / linear_fit previews and the background worker
- ``instrument`` recorder hooks (steps, blocks, group onload)
- ``meta``       ``qimg.latent.v1`` bundle metadata
- ``provider``   ``QimgDitProvider`` (entry point ``qimg.dit``)
"""
