#!/usr/bin/env bash
# Запуск команды в dev-контейнере: scripts/dev.sh npm test
# Исходники монтируются в /work, node_modules — в отдельном volume (бинарники под Linux).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="pi-supervisor-teo-dev:node26.12.1"

# Контекст закреплён явно: текущий контекст docker у пользователя может смотреть на удалённый сервер.
context="${TEO_DEV_DOCKER_CONTEXT:-orbstack}"
docker=(docker --context "$context")

if ! "${docker[@]}" image inspect "$image" >/dev/null 2>&1 || [[ "${TEO_DEV_REBUILD:-}" == 1 ]]; then
  "${docker[@]}" build -q -t "$image" -f "$repo/docker/dev.Dockerfile" "$repo/docker" >/dev/null
fi

tty_flags=()
if [[ -t 0 && -t 1 ]]; then tty_flags=(-it); fi

exec "${docker[@]}" run --rm ${tty_flags[@]+"${tty_flags[@]}"} \
  --user "$(id -u):$(id -g)" \
  -v "$repo:/work" \
  -v pi-supervisor-teo-node-modules:/work/node_modules \
  -v pi-supervisor-teo-npm-cache:/home/dev/.npm \
  -w /work \
  "$image" "$@"
