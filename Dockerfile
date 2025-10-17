FROM node:18-slim

# Install dependencies: ffmpeg, unoconv, LibreOffice, and fonts
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libreoffice \
  unoconv \
  python3 \
  fonts-dejavu-core \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
