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

RUN sed -i \
    -e 's|http://archive.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g' \
    -e 's|http://security.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g' \
    /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get -o Acquire::Retries=3 update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends fluxbox novnc websockify x11vnc \
  && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY public ./public
COPY docker ./docker
COPY .env.example ./

RUN chmod 755 /app/docker/start-with-desktop.sh

RUN mkdir -p /app/data
EXPOSE 3000
EXPOSE 6080
CMD ["/app/docker/start-with-desktop.sh"]
