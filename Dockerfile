# ------------------------------------------------------------
# ⚡ EverToolbox Backend Dockerfile (Render-Optimized & Compatible)
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
ENV TMPDIR=/dev/shm
ENV FFMPEG_THREADS=4
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=30

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

# 👇 This line will safely handle both cases (with or without package-lock.json)
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
# 🚀 Launch backend
# ------------------------------------------------------------
CMD ["node", "server.js"]
