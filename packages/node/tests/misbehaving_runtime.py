"""Test runtime entry that misbehaves on purpose (test fixture: CPU only, loads no model).

``PHASYN_TEST_MISBEHAVE`` selects the fault; anything else runs the normal ``phasyn_components.runtime_host``:

- ``silent``: the component process never says hello
- ``old_protocol``: it says hello with another protocol major version
- ``mute_load``: it says hello, then never answers ``load``
- ``fail_load``: ``test.echo`` fails while loading (MODEL_INCOMPATIBLE), after the Node's settings checks passed
- ``hang_describe``: ``--describe`` never answers

``PHASYN_TEST_DESCRIBE_LOG`` (a file path) gets one line per ``--describe`` run, so a test can count them.
NodeGateway tests start it as runtime ``{"module": "misbehaving_runtime", "env": {"PYTHONPATH": <tests dir>}}``.
"""

from __future__ import annotations

import os
import sys
import time

from phasyn_components import runtime_host

MODE_ENV = "PHASYN_TEST_MISBEHAVE"
DESCRIBE_LOG_ENV = "PHASYN_TEST_DESCRIBE_LOG"
MODULE = "misbehaving_runtime"
HANG_S = 120.0  # bounded: the Node is expected to stop the process long before this


def main() -> int:
    mode = os.environ.get(MODE_ENV, "")
    describing = "--describe" in sys.argv
    log = os.environ.get(DESCRIBE_LOG_ENV)
    if describing and log:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(f"{os.getpid()}\n")
    if (mode == "hang_describe" and describing) or (mode == "silent" and not describing):
        time.sleep(HANG_S)
        return 1
    if mode == "old_protocol":
        runtime_host.PROTOCOL_VERSION = "0.1.0"  # the hello message reads this module global
    if mode == "mute_load":
        runtime_host.RuntimeHost.handle_load = lambda self, msg: None  # type: ignore[method-assign]
    if mode == "fail_load":
        from phasyn_components.errors import ComponentError
        from phasyn_components.testing.echo import EchoProvider

        def fail(self: EchoProvider, ctx: object) -> None:
            raise ComponentError("MODEL_INCOMPATIBLE", "synthetic load failure (test fixture)")

        EchoProvider.load = fail  # type: ignore[assignment,method-assign]
    return runtime_host.main()


if __name__ == "__main__":
    sys.exit(main())
