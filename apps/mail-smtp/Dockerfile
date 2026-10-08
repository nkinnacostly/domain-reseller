# MyDomainsHub Mail's SMTP relay (docs/MAIL-SPEC.md §6, "SMTP"). Build from the repository root:
#   docker build -f apps/mail-smtp/Dockerfile .
# Secrets (the Supabase secret key, the API key pepper — never an SES key) come from the host's
# environment — `fly secrets set -c fly.smtp.toml` — never the image
# (.dockerignore keeps .env out of the build context).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
# No git here, so the repo's `prepare` (git hooks) must not run.
ENV npm_config_ignore_scripts=true
COPY . .
RUN pnpm install --frozen-lockfile --filter @dr/mail-smtp...
# One bundled dist/server.js (scripts/build.mjs), then production deps only.
RUN pnpm --filter @dr/mail-smtp build \
 && pnpm --filter @dr/mail-smtp deploy --prod --legacy /out \
 && cp -r apps/mail-smtp/dist /out/dist

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 2525 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
