FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY tsconfig.json ./
COPY scripts ./scripts
COPY lib ./lib
COPY data ./data

RUN mkdir -p /tmp/ci-vimeo-worker /app/logs /app/data

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
