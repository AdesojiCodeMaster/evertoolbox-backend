# Dockerfile - EverToolbox (full conversion support)
FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  poppler-utils \
  libreoffice \
  unoconv \
  imagemagick \
  ghostscript \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package.json / install first for caching
COPY package*.json ./
# RUN npm install --production
# ---- Install only production deps ----
RUN npm ci --omit=dev

# copy rest of files
COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
