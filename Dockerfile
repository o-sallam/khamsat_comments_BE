FROM node:18-bullseye-slim

RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libx11-xcb1 \
    libxshmfence1 \
    libpango-1.0-0 \
    libcairo2 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

RUN npx playwright install chromium --with-deps

COPY . .

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"

EXPOSE ${PORT:-3001}

CMD node server.js