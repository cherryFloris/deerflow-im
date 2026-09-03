# Multi-stage: build the vendored dsh-im React admin UI, then ship only the
# static bundle + the Node backend runtime. The admin UI (React/Vite) is a build-time
# dependency only; the running bridge serves the prebuilt public/ folder.
FROM node:22-alpine AS ui-builder
WORKDIR /app
COPY admin-ui/package.json ./admin-ui/package.json
RUN cd admin-ui && npm install
COPY admin-ui ./admin-ui
RUN cd admin-ui && npm run admin:build

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY --from=ui-builder /app/public ./public
ENV NODE_ENV=production
EXPOSE 10010
CMD ["node", "src/index.js"]
