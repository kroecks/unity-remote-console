FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY server.js ./
COPY public ./public

EXPOSE 8080
EXPOSE 9999/udp

CMD ["node", "server.js"]
