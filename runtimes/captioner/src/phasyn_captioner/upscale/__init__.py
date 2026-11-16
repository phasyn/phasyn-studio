"""``media.upscale``: built-in video super-resolution (Anime4K v4 ``Upscale_CNN_x2_VL``, MIT, vendored in ``third_party``).

``plan`` and ``shader`` are torch-free (bounds, geometry, tiles, GLSL parsing); ``model`` runs the chain in PyTorch,
``video`` drives FFmpeg and ``provider`` is the component. It lives in this runtime package because it is installed in
both H3 GPU environments (``x86_64`` and ``aarch64-sm121``) with torch, NumPy and ``phasyn_media`` already present.
"""
