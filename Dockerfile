# ---- Base Node.js image ----
FROM node:18-slim

# ---- Install conversion tools ----
# ffmpeg for audio/video
# libreoffice + unoconv for document conversions
# fonts for proper PDF export
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libreoffice \
  unoconv \
  python3 \
  fonts-dejavu-core \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---- App setup ----
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# ---- Expose port (Render uses this automatically) ----
EXPOSE 10000

# ---- Start the backend ----
CMD ["node", "server.js"]
