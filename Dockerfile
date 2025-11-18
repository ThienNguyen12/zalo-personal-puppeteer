# Chrome-ready Puppeteer on Render
FROM node:20-bullseye-slim

# Install system dependencies required by Chrome
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    fonts-liberation libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxrandr2 \
    libxdamage1 libxcomposite1 libxfixes3 \
    libxext6 libxrender1 libxtst6 \
    libnss3 libxss1 libglib2.0-0 libgbm1 \
    libpango-1.0-0 libcairo2 libatk1.0-0 \
    libgtk-3-0 libdrm2 libpangocairo-1.0-0 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install Google Chrome (needed for stable Puppeteer)
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list && \
    apt-get update && apt-get install -y google-chrome-stable

# Puppeteer will use Google Chrome installed above
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]
