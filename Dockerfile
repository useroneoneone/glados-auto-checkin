FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV npm_config_registry=$NPM_REGISTRY
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
