"""MiniMax H3 component providers for Phasyn Studio.

* ``providers`` / ``config`` / ``plan`` / ``host`` / ``bundles`` / ``references`` … — the component layer:
  settings, plans, ports, files and recording.
* ``recipe`` — the numeric H3 recipe over the pinned SGLang implementation (planning rules in
  ``recipe.adapter``, stage execution in ``recipe.runtime``, shared types in ``recipe.abi``).  Its math is
  kept as-is; changes there are structural only.

Importing this package never imports torch or SGLang; GPU code is imported lazily inside ``load()``.
"""
