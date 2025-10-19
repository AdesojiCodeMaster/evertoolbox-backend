# Dockerfile — EverToolbox Backend (Render-ready, Node 20 Slim)
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install all needed system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    poppler-utils \
    libreoffice \
    unoconv \
    imagemagick \
    ghostscript \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package files first (for caching)
COPY package*.json ./

# Install deps safely for production
RUN npm install --omit=dev

# Copy rest of your backend
COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
