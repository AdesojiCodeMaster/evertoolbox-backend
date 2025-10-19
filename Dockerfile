# -------------------------------------------------------
# 🧩 EverToolbox Backend Dockerfile
# -------------------------------------------------------
# Designed for Render or any Node.js deployment
# Simplicity, speed, and correctness — no folders/zips!
# -------------------------------------------------------

# 1️⃣ Base image
FROM node:20-alpine

# 2️⃣ Create and set working directory
WORKDIR /app

# 3️⃣ Copy only dependency manifests first for caching
COPY package*.json ./

# 3️⃣🅰️ make sure ffmpeg is installed inside the container:
RUN apk add --no-cache ffmpeg

# 4️⃣ Install only production dependencies
# (npm ci requires a lock file — npm install works fine without)
RUN npm install --omit=dev

# 5️⃣ Copy the rest of the application
COPY . .

# 6️⃣ Expose the backend port (adjust if your server uses a different one)
EXPOSE 5000

# 7️⃣ Environment setup for Render
ENV NODE_ENV=production

# 8️⃣ Start command
CMD ["node", "server.js"]
