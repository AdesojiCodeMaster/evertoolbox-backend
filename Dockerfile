# ------------------------------------------------------------
# 🧰 EverToolbox Backend Dockerfile (Render-ready)
# Supports PDF↔Image, Audio, Video, Office docs, etc.
# ------------------------------------------------------------

FROM node: 20-bullseye

# Create app directory
WORKDIR /app

# Install required system dependencies
# Includes: ffmpeg, ImageMagick, Ghostscript, LibreOffice
RUN apt-get update && \
    apt-get install -y ffmpeg imagemagick ghostscript libreoffice && \
    # ✅ Fix ImageMagick security policy for PDF conversion
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml || true && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-7/policy.xml || true && \
    # Clean up
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy the entire backend source code
COPY . .

# Expose port (Render automatically detects this)
EXPOSE 10000

# Define environment variables if needed
ENV PORT=10000
ENV NODE_ENV=production

# Start your server
CMD ["node", "server.js"]
