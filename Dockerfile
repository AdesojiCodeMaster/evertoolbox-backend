# ---------- BASE IMAGE ----------
FROM node:20-slim

# ---------- SYSTEM DEPENDENCIES ----------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    ghostscript \
    libreoffice \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# ---------- SECURITY POLICY FIX ----------
# Allow ImageMagick to read PDFs (Render sometimes restricts it)
RUN sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read|write" pattern="PDF" />|' /etc/ImageMagick-6/policy.xml || true

# ---------- WORKDIR & APP SETUP ----------
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install npm dependencies
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# ---------- ENVIRONMENT ----------
ENV NODE_ENV=production
ENV PORT=10000

# ---------- PORT ----------
EXPOSE 10000

# ---------- START COMMAND ----------
CMD ["node", "server.js"]
