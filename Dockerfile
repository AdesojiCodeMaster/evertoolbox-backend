# ---------- EverToolbox Backend Dockerfile (Render Ready) ----------
FROM node:20-slim

WORKDIR /app

# Install all required system tools for conversions and compression
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    ghostscript \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

# --- FIX: Allow ImageMagick to read PDF/PS files ---
# Render blocks PDF conversions by default, so we patch the policy.xml
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/g' /etc/ImageMagick-6/policy.xml || true
RUN sed -i 's/rights="none" pattern="PS"/rights="read|write" pattern="PS"/g' /etc/ImageMagick-6/policy.xml || true

# Copy package definition files
COPY package*.json ./

# Install only production dependencies (no dev)
RUN npm install --omit=dev

# Copy the entire project (backend + universal-filetool.js + everything else)
COPY . .

# Expose backend port (Render uses 10000 by default)
EXPOSE 10000

# Start the Node.js backend
CMD ["node", "server.js"]
