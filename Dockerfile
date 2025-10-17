FROM node:18-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    unoconv \
    libreoffice \
    python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p uploads processed
EXPOSE 10000
CMD ["node", "server.js"]
