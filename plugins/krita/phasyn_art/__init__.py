"""Register the Phasyn art exchange extension with Krita."""

from krita import Krita

from .extension import ArtExchange

app = Krita.instance()
app.addExtension(ArtExchange(app))
