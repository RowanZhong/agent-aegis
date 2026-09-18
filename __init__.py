"""Native Hermes v2026.8.19 plugin. The detection engine stays in TypeScript."""

def register(ctx):
    from .hermes_adapter import register as register_adapter
    register_adapter(ctx)
