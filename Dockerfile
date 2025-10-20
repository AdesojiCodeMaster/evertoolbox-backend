FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y ffmpeg imagemagick ghostscript libreoffice && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]
