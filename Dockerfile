# Use a lightweight Node.js image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install required system tools for conversions and compression
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    ghostscript \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

# Copy package definition files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy all project files (frontend + backend)
COPY . .

# Expose the port your server listens on
EXPOSE 10000

# Start the Node server
CMD ["node", "server.js"]
