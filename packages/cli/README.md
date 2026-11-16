# phasyn-cli

The `phasyn-studio` command of Phasyn Studio: start the controller and nodes, check the setup and manage services. See [Phasyn Studio](https://github.com/phasyn/phasyn-studio).

`phasyn-studio install` detects the machine, prints a deployment plan (`--dry-run`, `--json`), then installs,
configures and starts a single-machine deployment; `phasyn-studio up` starts it again and waits until its routes are
ready, and `phasyn-studio status` checks it without changing anything. See [INSTALL.md](../../INSTALL.md).
