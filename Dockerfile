FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
USER node
ENV NODE_ENV=production PORT=8080 DRY_RUN=true

FROM base AS test
COPY --chown=node:node test/ ./test/
RUN node --test

FROM base AS runtime
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/cloud.js"]
