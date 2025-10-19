# Dockerfile for EverToolbox Universal File Tool
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libreoffice \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Expose backend port
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
