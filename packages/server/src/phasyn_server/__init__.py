"""Shared HTTP layer of the Phasyn Studio controller and NodeGateway (no torch).

- :mod:`phasyn_server.http`: contract ``Error`` responses, bounded JSON bodies, query parameters, gzip JSON.
- :mod:`phasyn_server.middleware`: one error policy (no stack on the wire), the browser request guards (C7) and
  the ``Host`` policy (``allowed_hosts``, or the local default when it is not set).
- :mod:`phasyn_server.files`: streamed, hashed, size-bounded ``POST /api/files`` and byte-range file responses.
- :mod:`phasyn_server.recordings`: the shared recording query and streamed export endpoints (format, ``redact``).
- :mod:`phasyn_server.datadir`: the single-writer ``data_dir`` lock.
- :mod:`phasyn_server.serve`: the uvicorn server and logging setup used by ``run()``.
"""

from .datadir import DataDirBusy, DataDirLock
from .http import HttpLimits
from .middleware import HostPolicy, create_api, install
from .serve import Server, configure_logging

__all__ = [
    "DataDirBusy",
    "DataDirLock",
    "HostPolicy",
    "HttpLimits",
    "Server",
    "configure_logging",
    "create_api",
    "install",
]
