# ── build stage: compile the native audio modules ──────────────────────────
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ── runtime stage: node + ffmpeg + rclone, nothing else ────────────────────
FROM node:22-bookworm-slim

# UV_THREADPOOL_SIZE: every fs.* call in Node runs on libuv's threadpool,
# including the per-speaker fifo feeds in mixer.js. libuv sizes that pool
# once, lazily, from this variable - so it has to be in the real environment
# before the process starts. Setting it from inside index.js is NOT reliable:
# in an ES module every import is evaluated before the module body runs, so a
# dependency can create the pool at the default size of 4 first. This is the
# setting production actually gets (Railway builds this Dockerfile and runs
# docker-entrypoint.sh, which exec's CMD directly - `npm start`, and anything
# in package.json's scripts, is never involved). Four simultaneously blocked
# fs operations is all it took to starve the whole process in the mixdown
# incident this guards against.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    RCLONE_CONFIG=/data/rclone.conf \
    UV_THREADPOOL_SIZE=16

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl unzip \
 && case "$(dpkg --print-architecture)" in arm64) RCA=arm64 ;; *) RCA=amd64 ;; esac \
 && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/rclone-current-linux-${RCA}.zip" \
 && unzip -q /tmp/rclone.zip -d /tmp/rclone \
 && install -m 755 /tmp/rclone/*/rclone /usr/local/bin/rclone \
 && rm -rf /tmp/rclone /tmp/rclone.zip \
 && apt-get purge -y unzip curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY *.js ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && mkdir -p /data/sessions

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "index.js"]
