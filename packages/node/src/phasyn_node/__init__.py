"""Phasyn Studio NodeGateway (no torch).

One NodeGateway per host: component processes (one isolated runtime process per instance), file endpoints,
device sampling, recording upload and catalog reporting. Entry point: ``phasyn_node.main.run(config_path)``
(CLI ``phasyn-studio node --config``).
"""

from importlib.metadata import PackageNotFoundError, version


try:
    __version__ = version("phasyn-node")
except (
    PackageNotFoundError
):  # imported from a source tree that was never installed: say so, never guess
    __version__ = "0+unknown"

__all__ = ["__version__"]
