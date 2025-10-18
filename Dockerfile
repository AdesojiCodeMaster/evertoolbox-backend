FROM node:20-slim

# install all native tools
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libreoffice \
  unoconv \
  poppler-utils \
  imagemagick \
  ghostscript \
  pandoc \
  python3 \
  fonts-dejavu-core \
  libvips-dev \
  && rm -rf /var/lib/apt/lists/*

  
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
