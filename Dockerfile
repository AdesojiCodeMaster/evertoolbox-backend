# Dockerfile for EverToolbox backend (Full Conversion Support)
FROM node:18-bullseye

ENV DEBIAN_FRONTEND=noninteractive

# Install all needed system tools
RUN apt-get update && apt-get install -y \
  ffmpeg \
  poppler-utils \
  libreoffice \
  unoconv \
  ghostscript \
  imagemagick \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
