FROM mcr.microsoft.com/playwright:v1.53.0-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data logs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status))).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
