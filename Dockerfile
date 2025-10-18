# Dockerfile - builds an environment with all system tools
FROM node:18-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  poppler-utils \
  libreoffice \
  unoconv \
  imagemagick \
  ghostscript \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
