"""LoRA training on the H3 Ref2VA DiT (torch + pinned SGLang, imported lazily inside functions).

* :mod:`.model` - the frozen DiT (W8 storage), LoRA layers, autograd-safe block helpers, checkpointing;
* :mod:`.samples` - training samples from conditioning and reference bundles plus the target latents;
* :mod:`.target` - the target clip's latents with the pinned video VAE encoder;
* :mod:`.loop` - the resumable training loop with thermal and memory gates;
* :mod:`.export` - the trained factors as a PEFT (diffusers names) LoRA the DiT loads.
"""
