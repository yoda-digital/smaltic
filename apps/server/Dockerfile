# Smaltic server image. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t smaltic .

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src

# Dependency layer: manifests only, so source edits do not reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/model/package.json packages/model/
RUN pnpm install --frozen-lockfile --filter "@smaltic/server..."

COPY packages/model packages/model
COPY apps/server apps/server
RUN pnpm --filter "@smaltic/server..." build \
 && pnpm --filter @smaltic/server deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 SMALTIC_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out ./
COPY apps/server/docker/entrypoint.sh /usr/local/bin/smaltic-entrypoint
RUN chmod 755 /usr/local/bin/smaltic-entrypoint && mkdir -p /data && chown node:node /data
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["smaltic-entrypoint"]
# main.js applies pending migrations, then serves on $PORT.
CMD ["node", "dist/main.js"]
