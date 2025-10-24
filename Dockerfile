# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Render-Optimized & Stable)
# Faster conversions: tuned for ffmpeg, LibreOffice, ImageMagick
# ------------------------------------------------------------

FROM node:20-bullseye

# ------------------------------------------------------------
# 📂 Set working directory
# ------------------------------------------------------------
WORKDIR /app

# ------------------------------------------------------------
# 🧩 Install core system dependencies
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
      fonts-freefont-ttf \
      fonts-liberation \
      curl \
      && \
    \
    # ✅ Fix ImageMagick security policy for PDF & PS conversions
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PS" \/>/<policy domain="coder" rights="read|write" pattern="PS" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PS" \/>/<policy domain="coder" rights="read|write" pattern="PS" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    \
    # ✅ Clean apt cache
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# ⚙️ Performance tuning
# ------------------------------------------------------------
# 🧠 Use /tmp instead of /dev/shm (Render gives /dev/shm only 64MB)
ENV TMPDIR=/tmp

# ⚡ Optimize ffmpeg performance
ENV FFMPEG_THREADS=4
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=30

# 🗂️ Ensure LibreOffice user config folder exists
RUN mkdir -p /root/.config/libreoffice/4/user

# ------------------------------------------------------------
# 🪄 Prewarm essential tools
# ------------------------------------------------------------
RUN ffmpeg -version && \
    libreoffice --headless --version && \
    convert -version && \
    gs --version && \
    pandoc -v && \
    echo "✅ Prewarm complete."

# ------------------------------------------------------------
# 📦 Install Node.js dependencies
# ------------------------------------------------------------
COPY package*.json ./

# 👇 This safely handles both cases (with or without package-lock.json)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --production; fi

# ------------------------------------------------------------
# 🧠 Copy app source
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# 🌐 Expose and configure environment
# ------------------------------------------------------------
EXPOSE 10000
ENV PORT=10000
ENV NODE_ENV=production

# ------------------------------------------------------------
# ❤️ Optional healthcheck for uptime monitoring
# ------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:10000/health || exit 1

# ------------------------------------------------------------
# 🚀 Launch backend
# ------------------------------------------------------------
CMD ["node", "server.js"]
