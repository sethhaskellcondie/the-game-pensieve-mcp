# syntax=docker/dockerfile:1

# --- build stage: compile TypeScript ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- prod deps only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
EXPOSE 3000

# Run unprivileged. `node` (uid 1000) ships with the official image, so there is no user to create.
USER node

# Liveness for `docker compose ps` and for Caddy's depends_on. /healthz is deliberately public and does not
# touch the backend, so this reports on THIS container only.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

CMD ["node", "dist/index.js"]
