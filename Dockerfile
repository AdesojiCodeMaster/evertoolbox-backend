# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Optimized Multi-Stage)
# Lighter, faster, and pre-tuned for Render/Netlify backends
# ------------------------------------------------------------

# === Stage 1: Build dependencies ===
FROM node:20-bullseye AS build

WORKDIR /app

# Copy only package files first for better layer caching
COPY package*.json ./

# Install only production deps (no dev) to reduce size
RUN npm ci --only=production

# === Stage 2: Runtime image ===
FROM node:20-bullseye AS runtime

# ------------------------------------------------------------
# 🧩 Install system dependencies
# ------------------------------------------------------------
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ffmpeg \
      imagemagick \
      ghostscript \
      libreoffice \
      pandoc \
      poppler-utils \
      fonts-dejavu-core \
      && \
    # ✅ Allow ImageMagick to read/write PDFs
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# ⚙️ Environment tuning
# ------------------------------------------------------------
ENV NODE_ENV=production
ENV PORT=10000
ENV TMPDIR=/dev/shm
ENV FFMPEG_THREADS=2

# ------------------------------------------------------------
# 🧠 Copy pre-built node_modules from build stage
# ------------------------------------------------------------
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules

# ------------------------------------------------------------
# 📦 Copy source code
# ------------------------------------------------------------
COPY . .

# Optional: prewarm major tools (for Render cold starts)
RUN ffmpeg -version && libreoffice --headless --version && convert -version && gs --version && pandoc -v && echo "✅ Tools verified."

# ------------------------------------------------------------
# 🌐 Expose port and launch
# ------------------------------------------------------------
EXPOSE 10000
CMD ["node", "server.js"]
