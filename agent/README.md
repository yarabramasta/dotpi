# agent/

This directory is the source of truth for `~/.pi/agent`.

- `settings.json`, `models.json`, and agent definitions under `agents/` are tracked here.
- `./dotpi install` mirrors tracked `agent/` files into `~/.pi/agent` (clean mode copies the whole tree; safe mode copies JSON files). `./dotpi sync -s -M` updates only `settings.json` and `models.json` in place.
- `auth.json` is an example — real credentials live in environment variables.
