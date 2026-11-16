"""Torch-free contracts and data types shared by the H3 adapter (planning) and runtime (execution).

* ``resolve``  — inputs and outputs of :meth:`phasyn_h3.recipe.adapter.H3Adapter.resolve`;
* ``stage``    — the stage execution ABI (context, inputs, outputs, result, cancellation);
* ``component``— component load specs and registry leases;
* ``contracts``— the recipe's JSON Schema contracts (``schemas/``) and their validation;
* ``tensors``  — bounded safetensors reader/writer and bundle checks;
* ``media_types``, ``values``, ``errors``, ``canonical``, ``timeutil`` — small shared helpers.

Nothing in this package imports torch or any GPU library.
"""
