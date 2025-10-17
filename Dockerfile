# ---- Base Node.js image ----
FROM node:18-slim

# ---- Install conversion + compression tools ----
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libreoffice \
  unoconv \
  python3 \
  python3-uno \
  fonts-dejavu-core \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---- Start LibreOffice listener for unoconv ----
RUN mkdir -p /usr/lib/libreoffice/program
ENV UNO_PATH=/usr/lib/libreoffice/program
ENV PYTHONPATH=/usr/lib/python3/dist-packages

# ---- App setup ----
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# ---- Expose port ----
EXPOSE 10000

# ---- Start the backend ----
CMD service libreoffice start && \
    unoconv --listener & \
    node server.js
    
