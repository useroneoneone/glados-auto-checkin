FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV npm_config_registry=https://registry.npmmirror.com
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_retry_mintimeout=20000
ENV npm_config_fetch_retry_maxtimeout=120000
ENV npm_config_fetch_timeout=300000

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY .env.example ./

RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "start"]
