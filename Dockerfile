FROM node:20-slim

# Install Stockfish (Debian puts it in /usr/games/)
RUN apt-get update && \
    apt-get install -y --no-install-recommends stockfish && \
    rm -rf /var/lib/apt/lists/* && \
    ls -la /usr/games/stockfish

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

ENV STOCKFISH_PATH=/usr/games/stockfish

EXPOSE 3000

CMD ["node", "server.js"]
