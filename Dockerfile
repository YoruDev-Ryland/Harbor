# Node 24.18.0 LTS / Alpine 3.23 multi-architecture index, reviewed 2026-07-19.
# Dependabot proposes digest updates; release CI rebuilds and rescans each one.
ARG NODE_IMAGE=node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436

# ── build stage ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# native module toolchain for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

# ── runtime stage ───────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG HARBOR_VERSION=0.1.4
ARG HARBOR_REVISION=unknown
ARG HARBOR_SOURCE=""
ARG HARBOR_CREATED=unknown
ENV HARBOR_VERSION=${HARBOR_VERSION}
LABEL org.opencontainers.image.title="Harbor" \
      org.opencontainers.image.description="A self-hosted dashboard for servers and web applications" \
      org.opencontainers.image.version=${HARBOR_VERSION} \
      org.opencontainers.image.revision=${HARBOR_REVISION} \
      org.opencontainers.image.source=${HARBOR_SOURCE} \
      org.opencontainers.image.created=${HARBOR_CREATED} \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server \
  && apk del python3 make g++ \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
ENV PORT=9090 HARBOR_DATA=/data
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health/ready || exit 1

CMD ["node", "server/dist/index.js"]
