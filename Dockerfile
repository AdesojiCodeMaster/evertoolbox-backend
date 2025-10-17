FROM node:20-bullseye

# install all native tools
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
  fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
