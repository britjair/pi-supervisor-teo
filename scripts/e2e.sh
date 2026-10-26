#!/usr/bin/env bash
# Изолированный e2e: исходный Pi config смонтирован только для чтения, SDK пишет во временную копию.
# Аргументы передаются vitest: scripts/e2e.sh test/e2e/pi-smoke.test.ts
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="${TEO_E2E_AGENT_DIR:-$HOME/.pi/agent}"
if [[ ! -f "$agent_dir/auth.json" || ! -f "$agent_dir/settings.json" ]]; then
  echo 'Нужны auth.json и settings.json Pi (TEO_E2E_AGENT_DIR).' >&2
  exit 2
fi
"$repo/scripts/dev.sh" npm run build >/dev/null
mounts=(-v "$agent_dir/auth.json:/tmp/pi-input/auth.json:ro" -v "$agent_dir/settings.json:/tmp/pi-input/settings.json:ro")
for file in models.json models-store.json; do
  if [[ -f "$agent_dir/$file" ]]; then mounts+=(-v "$agent_dir/$file:/tmp/pi-input/$file:ro"); fi
done
context="${TEO_DEV_DOCKER_CONTEXT:-orbstack}"
docker --context "$context" run --rm --user "$(id -u):$(id -g)" \
  -v "$repo:/work" -v pi-supervisor-teo-node-modules:/work/node_modules \
  -v pi-supervisor-teo-npm-cache:/home/dev/.npm "${mounts[@]}" -w /work \
  pi-supervisor-teo-dev:node26.12.1 sh -c '
    set -e
    mkdir -m 700 /tmp/pi-e2e-copy
    for name in auth.json settings.json models.json models-store.json; do
      if [ -f "/tmp/pi-input/$name" ]; then cp "/tmp/pi-input/$name" "/tmp/pi-e2e-copy/$name"; chmod 600 "/tmp/pi-e2e-copy/$name"; fi
    done
    # Убираем установленные расширения/пакеты из e2e, оставляем только модель и авторизацию.
    node -e '\''const fs=require("node:fs"); const p="/tmp/pi-e2e-copy/settings.json", s=JSON.parse(fs.readFileSync(p)); fs.writeFileSync(p,JSON.stringify({defaultProvider:s.defaultProvider,defaultModel:s.defaultModel,defaultThinkingLevel:s.defaultThinkingLevel}));'\''
    if [ $# -eq 0 ]; then set -- test/e2e; fi
    TEO_E2E=1 PI_CODING_AGENT_DIR=/tmp/pi-e2e-copy npx vitest run "$@"
  ' sh "$@"
