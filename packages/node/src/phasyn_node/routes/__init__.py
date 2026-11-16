"""NodeGateway HTTP routes, one module per resource.

Each module exposes ``routes(service) -> APIRouter``: the same explicit closure-factory pattern as the
controller, so ``create_app`` only assembles them.
"""
