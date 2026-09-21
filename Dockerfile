FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    STORAGE_PATH=/app/storage \
    PROFILE_PATH=/app/storage/browser-profile \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      curl \
      dbus-x11 \
      dumb-init \
      fluxbox \
      fonts-noto-cjk \
      novnc \
      websockify \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY start-worker.sh /usr/local/bin/start-worker.sh
RUN chmod 0755 /usr/local/bin/start-worker.sh \
    && mkdir -p /app/storage/browser-profile /app/storage/shots \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/start-worker.sh"]
