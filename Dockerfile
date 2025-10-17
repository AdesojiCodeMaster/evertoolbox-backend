# ---- Base image ----
FROM node:18-slim

# ---- System setup ----
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libreoffice \
    unoconv \
    ghostscript \
    poppler-utils \
    python3 \
    python3-pip \
    libc6-dev \
    libvips-dev \
 && rm -rf /var/lib/apt/lists/*

# ---- Create app directory ----
WORKDIR /app

# ---- Copy package.json ----
COPY package*.json ./

# ---- Install dependencies ----
RUN npm install --production

# ---- Copy all backend files ----
COPY . .

# ---- Expose port ----
EXPOSE 3000

# ---- Start the app ----
CMD ["node", "server.js"]
