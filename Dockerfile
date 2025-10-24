# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Render-Optimized)
# Faster conversions: tuned for ffmpeg, LibreOffice, ImageMagick
# ------------------------------------------------------------

FROM node:20-bullseye

# Set working directory
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
    # ✅ Fix ImageMagick security policy for PDF conversion
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    # ✅ Clean cache
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# ⚙️ Performance environment variables
# ------------------------------------------------------------
ENV TMPDIR=/dev/shm
ENV FFMPEG_THREADS=2
RUN mkdir -p /root/.config/libreoffice/4/user

# ------------------------------------------------------------
# 📦 Install Node dependencies
# ------------------------------------------------------------
COPY package*.json ./

# ✅ Use npm install for flexibility (Render-friendly)
RUN npm install --omit=dev

# ------------------------------------------------------------
# 🧠 Copy application source code
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# 🌐 Environment & Ports
# ------------------------------------------------------------
EXPOSE 10000
ENV PORT=10000
ENV NODE_ENV=production

# ------------------------------------------------------------
# 🪄 Prewarm key tools (optional but helpful)
# ------------------------------------------------------------
RUN ffmpeg -version && \
    libreoffice --headless --version && \
    convert -version && \
    gs --version && \
    pandoc -v && \
    echo "✅ Prewarm complete."

# ------------------------------------------------------------
# 🚀 Start backend
# ------------------------------------------------------------
CMD ["node", "server.js"]
