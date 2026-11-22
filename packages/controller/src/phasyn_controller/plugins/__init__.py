"""Studio plugin packages on the Controller (x-phasyn-extension).

A plugin package is data from a stranger: declarative contributions (prompt rules, recommended sets, generation
settings) and, in a later version, code that runs only in a sandbox in the browser. The Controller validates,
stores and serves packages and publishes the registry that the browser evaluates rules from.
It never imports or executes anything from a package, and the API cannot bring executable code onto this host.

- ``store``: the packages on disk, the registry, installation and removal (one writer at a time)
- ``api``: the HTTP routes
"""

from .api import PLUGIN_FILE_HEADERS, routes
from .store import STORE_DIR, PluginStore


__all__ = ["PLUGIN_FILE_HEADERS", "STORE_DIR", "PluginStore", "routes"]
