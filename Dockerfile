# abuseguard service image. Not built in the authoring environment (no Docker daemon): see README "Status".
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
# The core has no runtime dependencies; the service needs the optional Postgres driver.
RUN npm install --omit=dev --no-audit --no-fund pg@8

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY service ./service
COPY contracts ./contracts
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node service/migrate.js || exit 1; fi; exec node service/server.js"]
