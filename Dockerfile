# ------------------------------------------------------------
# 🧰 EverToolbox Backend Dockerfile (Render-ready, Full Support)
# Supports PDF↔Image, Audio, Video, Office docs, etc.
# ------------------------------------------------------------

FROM node:20-bullseye

# Create app directory
WORKDIR /app

# Install all required system dependencies
# Includes: ffmpeg, ImageMagick, Ghostscript, LibreOffice, Pandoc, Poppler
RUN apt-get update && \
    apt-get install -y \
      ffmpeg \
      imagemagick \
      ghostscript \
      libreoffice \
      pandoc \
      poppler-utils && \
    \
    # ✅ Fix ImageMagick security policy for PDF conversion
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    \
    # ✅ Clean up to keep image small
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy the backend source code
COPY . .

# Expose port for Render
EXPOSE 10000

# Environment variables
ENV PORT=10000
ENV NODE_ENV=production

# Start the backend
CMD ["node", "server.js"]
