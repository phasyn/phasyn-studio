"""Package the first-party Krita extension alongside the built Studio interface."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def main() -> None:
    """Write Krita's standard plugin layout with deterministic bytes."""
    app = Path(__file__).resolve().parents[1]
    source = app.parents[1] / "plugins" / "krita"
    target = app / "dist" / "phasyn-krita.zip"
    files = ("phasyn_art.desktop", "phasyn_art/__init__.py", "phasyn_art/exchange.py", "phasyn_art/extension.py")
    with ZipFile(target, "w") as bundle:
        for name in files:
            info = ZipInfo(name)
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, (source / name).read_bytes(), compress_type=ZIP_DEFLATED)


if __name__ == "__main__":
    main()
