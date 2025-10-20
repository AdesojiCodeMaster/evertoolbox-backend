FROM node:20-slim

WORKDIR /app

COPY package*.json ./

# install all needed tools
RUN apt-get update && apt-get install -y ffmpeg imagemagick ghostscript libreoffice && rm -rf /var/lib/apt/lists/*

# use npm install instead of npm ci (since package-lock.json is missing)
RUN npm install --omit=dev

COPY . .

CMD ["node", "server.js"]
