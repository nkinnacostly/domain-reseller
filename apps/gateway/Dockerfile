# Registrar gateway (PRD §6.4, ADR-004). Build from the repository root:
#   docker build -f apps/gateway/Dockerfile .
# Deploy on infrastructure with a STATIC EGRESS IP when the supplier enforces
# its allowlist (PRD §5.5, V2). Secrets come from the host's environment,
# never the image (.dockerignore keeps .env out of the build context).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
# No git here, so the repo's `prepare` (git hooks) must not run.
ENV npm_config_ignore_scripts=true
COPY . .
RUN pnpm install --frozen-lockfile --filter @dr/gateway...
# One bundled dist/server.js (scripts/build.mjs), then production deps only.
RUN pnpm --filter @dr/gateway build \
 && pnpm --filter @dr/gateway deploy --prod --legacy /out \
 && cp -r apps/gateway/dist /out/dist

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
