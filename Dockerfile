# Dockerfile - EverToolbox (production-ready)
FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install runtime tools required by backend conversion pipelines
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    poppler-utils \
    libreoffice \
    unoconv \
    imagemagick \
    ghostscript \
    procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies (use npm install to avoid ci issues on some hosts)
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Expose the port (server.js is expected to honor process.env.PORT || 10000)
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
