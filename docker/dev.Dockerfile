# Окружение сборки и тестов pi-supervisor-teo. На хост ничего не ставится (см. README, раздел «Разработка»).
# Версия Node совпадает с Node из Homebrew на хосте, на котором работает pi.
FROM node:26.12.1-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && git config --system user.name "teo-dev" \
 && git config --system user.email "teo-dev@localhost" \
 && git config --system init.defaultBranch main

# node_modules и кэш npm живут в именованных volume: контейнер работает с UID хоста,
# поэтому каталоги создаются заранее с правами на запись для любого пользователя.
RUN mkdir -p /work/node_modules /home/dev/.npm \
 && chmod 0777 /work/node_modules /home/dev /home/dev/.npm

ENV HOME=/home/dev \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /work
