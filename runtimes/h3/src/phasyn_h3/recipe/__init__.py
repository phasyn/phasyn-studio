"""The MiniMax H3 numeric recipe over pinned SGLang ``de487f8`` (planning, stage execution, shared types).

* ``abi``     — torch-free contracts and data types shared by planning and execution;
* ``adapter`` — torch-free model rules: geometry, sigma schedule, task/material/profile/LoRA rules, manifests;
* ``runtime`` — stage execution on the GPU: component lifecycle, loaders, stages, policies, upstream patches
  (every patched upstream source is pinned in ``runtime/pins.py``).

Dependencies point one way: ``abi`` uses the standard library, jsonschema and ``phasyn_components.errors``;
``adapter`` uses ``abi`` (and numpy); ``runtime`` uses ``abi``, ``adapter``, ``phasyn_media`` (lazily) and
the stdlib-only ``phasyn_components.upstream`` / ``model_identity``, and imports torch / SGLang only inside
functions.  Nothing here imports the component layer (``phasyn_h3`` top level).

Numerics follow the pinned SGLang implementation exactly; edits here change structure, naming, imports or
error handling only.  Rule identifiers (``RULE-nnn``, ``REQ-nnn``, ``AC-nnn``, ``IMP-nnn``, ``ADR-nnn``,
``BLK-nnn``) refer to ```` (anchor = the lower-case identifier, e.g.
````); `` §n`` refers to ````.
"""
