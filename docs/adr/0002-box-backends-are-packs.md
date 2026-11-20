# Box backends are packs

A Box backend adapter, such as Coder or a plain SSH host, is a pack that exports `backend(settings, process)` through a `box-backend` handler, with a capability set for the optional operations (`create`, `start`, `stop`, `delete`, `image`). We chose packs over adapters built into the engine so that a team can ship a backend for its own devbox tool from a private pack source, without an engine change. The engine checks at pack load that each optional operation matches its capability.
