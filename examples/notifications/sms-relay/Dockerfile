FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436

LABEL org.opencontainers.image.title="Harbor SMS relay helper" \
      org.opencontainers.image.description="Optional authenticated SignalWire-compatible SMS relay for Harbor users" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --chown=node:node server.js ./server.js
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.js"]
