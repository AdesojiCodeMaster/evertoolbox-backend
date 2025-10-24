# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Render-Optimized)
# Faster conversions: tuned for ffmpeg, LibreOffice, ImageMagick
# ------------------------------------------------------------

FROM node:20-bullseye

# Set workdir
WORKDIR /app

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
    \
    # ✅ Fix ImageMagick security policy for PDF conversion
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    \
    # ✅ Clean cache
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# ⚙️ Performance environment variables
# ------------------------------------------------------------
# Use in-memory tmpfs for faster I/O (Render compatible)
ENV TMPDIR=/dev/shm

# Force ffmpeg to use multiple threads
ENV FFMPEG_THREADS=4

# Optional: reduce LibreOffice cold start lag
RUN mkdir -p /root/.config/libreoffice/4/user

# ------------------------------------------------------------
# 🪄 Prewarm key tools (optional but speeds first request)
# ------------------------------------------------------------
RUN ffmpeg -version && \
    libreoffice --headless --version && \
    convert -version && \
    gs --version && \
    pandoc -v && \
    echo "✅ Prewarm complete."

# ------------------------------------------------------------
# 📦 Install Node dependencies
# ------------------------------------------------------------
COPY package*.json ./
RUN npm install --production

# ------------------------------------------------------------
# 🧠 Copy app source
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# 🌐 Expose port and environment
# ------------------------------------------------------------
EXPOSE 10000
ENV PORT=10000
ENV NODE_ENV=production

# ------------------------------------------------------------
# 🚀 Start backend
# ------------------------------------------------------------
CMD ["node", "server.js"]
