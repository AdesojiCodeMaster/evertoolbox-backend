# Use official Node LTS image
FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install --production

# Copy rest of the app
COPY . .

# Expose your app port
EXPOSE 10000

# Start command
CMD ["npm", "start"]
