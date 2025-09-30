# Use Node.js LTS with a full Debian-based image for better compatibility
FROM node:18-bullseye

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright and its dependencies
RUN npm init -y && \
    npm install @playwright/test

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

# Set environment variables
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy application code
COPY . .

# Expose the port the app runs on
EXPOSE 3001

# Command to run the application
CMD ["node", "server.js"]
