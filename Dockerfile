# Use a single stage build for Railway
FROM node:18-bullseye-slim

# Install Playwright system dependencies
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

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code BEFORE installing Playwright
COPY . .

# Install Playwright and Chromium browser AFTER copying app code
# This ensures browsers are installed in the correct location
RUN npx playwright install chromium --with-deps

# Set environment variables for Railway
ENV NODE_ENV=production

# Railway uses PORT environment variable
EXPOSE ${PORT:-3001}

# Use PORT from Railway or default to 3001
CMD node server.js