# Depth staging

An example Phasyn Studio plugin package: two prompt rules written as phrase lists and one recommended set. It contains no code.

- `no-flat-staging` blocks side-on staging wording and asks for depth staging.
- `handheld` adds a handheld-camera description to every shot.
- The set `depth-action` selects both.

Build the installable file from this directory with
`uv run python tools/contracts/pack_studio_plugin.py examples/studio-plugins/depth-staging --write-integrity`,
then install `com.example.depth-staging-1.0.0.phasynplugin` in the plugin manager of the Video Studio.
