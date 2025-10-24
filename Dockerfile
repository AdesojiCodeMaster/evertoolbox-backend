# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Render-Optimized)
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
# Use in-memory tmpfs for faster temporary I/O
ENV TMPDIR=/dev/shm

# Optimize ffmpeg threading and video encoding
ENV FFMPEG_THREADS=4
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=30

# Optional: reduce LibreOffice cold start lag
RUN mkdir -p /root/.config/libreoffice/4/user

# ------------------------------------------------------------
# 🪄 Prewarm essential tools (optional but improves first call latency)
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
RUN npm ci --omit=dev

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
# 🚀 Launch backend
# ------------------------------------------------------------
CMD ["node", "server.js"]
