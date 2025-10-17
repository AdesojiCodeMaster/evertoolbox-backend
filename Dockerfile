# ---- Base image ----
FROM node:18-bullseye

# ---- System dependencies for conversions ----
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libreoffice \
    unoconv \
    ghostscript \
    poppler-utils \
    imagemagick \
    python3 \
    python3-pip \
 && rm -rf /var/lib/apt/lists/*

# ---- App setup ----
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Ensure uploads/processed folders exist
RUN mkdir -p uploads processed

# ---- Expose and run ----
EXPOSE 10000
CMD ["node", "server.js"]
