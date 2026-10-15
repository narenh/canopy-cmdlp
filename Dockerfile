# Debian, not Alpine: yt-dlp's standalone build, Deno, and Debian's ffmpeg
# are all built against glibc.

# ---- yt-dlp: the stable release, checked against its SHA2-256SUMS ----
# The standalone build (Python and the YouTube challenge solver,
# yt-dlp-ejs, inside). This copy stays in the image as the last fallback;
# at start the server copies it to the volume, where it updates itself to
# nightly.
FROM debian:bookworm-slim AS ytdlp
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) f=yt-dlp_linux ;; \
      arm64) f=yt-dlp_linux_aarch64 ;; \
      *) echo "no yt-dlp build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base=https://github.com/yt-dlp/yt-dlp/releases/latest/download; \
    curl -fsSLO "$base/$f"; \
    curl -fsSL "$base/SHA2-256SUMS" | grep " $f\$" | sha256sum -c -; \
    mv "$f" yt-dlp; chmod 755 yt-dlp

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
# ci, not install: exactly what package-lock.json says.
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
# ffmpeg (and ffprobe) for the .m4a; tini so yt-dlp's own child processes
# get reaped and SIGTERM reaches node.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp runs YouTube's JavaScript challenges with Deno, which it finds on
# PATH. It wants 2.3 or newer.
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno
COPY --from=ytdlp /dl/yt-dlp /usr/local/lib/yt-dlp/yt-dlp

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV YTDLP_STABLE=/usr/local/lib/yt-dlp/yt-dlp
ENV DENO_DIR=/app/data/cache/deno

# Persist this path with a Coolify volume: the self-updating yt-dlp
# (bin/), its cache, and the audio (zones/) live here.
VOLUME ["/app/data"]

EXPOSE 3000

# The image's own yt-dlp, Deno, and ffmpeg run, or the build fails here
# instead of at the first link.
RUN /usr/local/lib/yt-dlp/yt-dlp --version && deno --version && ffmpeg -version | head -1

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
