# Untested locally (Docker unavailable on the dev machine) — see docs/DEPLOYMENT.md.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# tsx is needed at runtime until a bundled build step is added.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY config config
COPY prompts prompts

USER node
EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000
CMD ["npm", "start", "-w", "@alvip/server"]
