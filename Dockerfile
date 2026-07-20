# syntax=docker/dockerfile:1

# Build stage: full image so node-pty's native addon can compile.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: slim image + the real OpenSSH client the server drives.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Runs as the non-root `node` user; ssh reads /home/node/.ssh — mount your
# config/keys there (see README). Use `--user root` if bind-mount ownership
# on your platform makes the keys unreadable for uid 1000.
USER node

# Stdio MCP server: run with `docker run -i` so stdin stays open.
ENTRYPOINT ["node", "dist/index.js"]
