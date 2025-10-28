# Dockerfile for torrent-stream app
FROM node:20-slim

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy source files
COPY . .

# Expose app port
EXPOSE 3050

# Start the app
CMD ["node", "server.mjs"]
