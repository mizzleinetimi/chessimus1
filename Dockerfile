FROM node:20-slim

# Install Stockfish
RUN apt-get update && \
    apt-get install -y --no-install-recommends stockfish && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy app
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
