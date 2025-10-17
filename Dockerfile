# ---- Base image ----
FROM node:18-bullseye

# ---- Install conversion tools ----
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libreoffice \
    unoconv \
    poppler-utils \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# ---- Set work directory ----
WORKDIR /usr/src/app

# ---- Copy project files ----
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ---- Expose Render port ----
EXPOSE 10000

# ---- Start the unoconv listener + server ----
CMD unoconv --listener & node server.js
