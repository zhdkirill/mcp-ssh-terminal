# syntax=docker/dockerfile:1

# Build stage: node-pty ships no linux prebuilds, so node-gyp compiles it here.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: alpine + the real OpenSSH client the server drives.
FROM node:22-alpine
RUN apk add --no-cache openssh-client libstdc++
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
