FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/build.js scripts/build.js
COPY web web
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist dist
COPY server server
COPY scripts scripts
COPY supabase supabase
COPY index.html styles.css script.js ./
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
