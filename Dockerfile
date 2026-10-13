FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS base
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 AP_DENO_PATH=/usr/local/bin/deno REDISMS_DISABLE_POSTINSTALL=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 g++ make git poppler-utils poppler-data procps unzip curl ca-certificates iptables libcap2 && rm -rf /var/lib/apt/lists/*
RUN architecture="$(uname -m)" && case "$architecture" in x86_64) bun_arch=x64-baseline; deno_arch=x86_64;; aarch64) bun_arch=aarch64; deno_arch=aarch64;; *) exit 1;; esac && curl -fsSL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip && unzip /tmp/bun.zip -d /tmp/bun && mv /tmp/bun/bun-*/bun /usr/local/bin/bun && curl -fsSL --retry 3 "https://github.com/denoland/deno/releases/download/v2.9.3/deno-${deno_arch}-unknown-linux-gnu.zip" -o /tmp/deno.zip && unzip /tmp/deno.zip -d /usr/local/bin && rm -rf /tmp/bun /tmp/bun.zip /tmp/deno.zip && bun --version && deno --version
RUN cd /usr/src && bun install isolated-vm@6.2.0
FROM base AS build
WORKDIR /usr/src/app
COPY . .
RUN test ! -e packages/ee && test ! -e packages/server/api/src/app/ee
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN npm run check:distribution:build
RUN NODE_OPTIONS=--max-old-space-size=4096 bun x turbo run build --concurrency=2 --filter=web --filter=@activepieces/engine --filter=api --filter=worker
RUN node scripts/stage-sydekyks-runtime.mjs && cd runtime && bun install --lockfile-only --ignore-scripts && cd .. && node scripts/check-runtime-resolution.mjs && node scripts/audit-distribution-boundaries.mjs runtime --artifact
FROM base AS run
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/runtime/ ./
COPY --from=build /usr/src/app/packages/server/api/src/assets/default.cf /usr/local/etc/isolate
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
ENV NODE_ENV=production AP_EDITION=ce AP_DB_TYPE=POSTGRES AP_REDIS_TYPE=STANDALONE
ARG SYDEKYKS_SOURCE_REVISION
LABEL org.opencontainers.image.title="Sydekyks" org.opencontainers.image.version="1.0.6" org.opencontainers.image.revision=$SYDEKYKS_SOURCE_REVISION org.opencontainers.image.source="https://github.com/leroborat/sydekyks-platform" service="sydekyks"
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 CMD [ "$AP_CONTAINER_TYPE" = "WORKER" ] && exit 0 || curl -fsS "http://localhost:${AP_PORT:-80}/api/v1/health" || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
EXPOSE 80
