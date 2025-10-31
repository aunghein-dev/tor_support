# Base image
FROM node:20-slim

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Use a smaller memory footprint
ENV NODE_ENV=production
EXPOSE 3050

CMD ["node", "--max-old-space-size=512", "server.mjs"]
