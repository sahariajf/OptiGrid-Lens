# Fallback execution path for the judges. Multi-stage so the runtime image
# carries only the standalone server bundle, not the build toolchain.
#
#   docker build -t optigrid-lens .
#   docker run --rm -p 3000:3000 -e OPENAI_API_KEY=... optigrid-lens
#
# No secret is baked in: the key arrives at runtime through -e or --env-file.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Unprivileged runtime user.
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# HOSTNAME=0.0.0.0 above is what makes the port reachable from outside the
# container; Next's default of localhost would only bind inside it.
CMD ["node", "server.js"]
