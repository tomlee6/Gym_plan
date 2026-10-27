# syntax=docker/dockerfile:1
#
# Container image for the backend API and the Node job worker (D-11). One
# image, two commands: the API runs `node src/server.js` (the default CMD) and
# the worker service overrides it with `node src/worker.js`.
#
# Build from the repository root, not from backend/, because the backend
# imports the plan library from ../../../shared/plan/index.js:
#
#   docker build -f backend/Dockerfile -t flexgym-backend .
#
# Layout inside the image mirrors the repo so those relative imports resolve:
#   /app/backend  the API (working directory)
#   /app/shared   the shared plan library

# ---- deps: install production dependencies only ------------------------------
FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DB_SSL_CA=/app/rds-global-bundle.pem
WORKDIR /app

# Amazon RDS's certificate authorities, so DB_SSL=true can verify the
# database (the parameter group requires TLS). Node does not ship them.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

# The shared library has no dependencies of its own; copying it is enough.
COPY --chown=node:node shared/ ./shared/
COPY --from=deps --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node backend/ ./backend/

WORKDIR /app/backend
# The image's built-in unprivileged user. Nothing in the app needs root.
USER node

EXPOSE 8080

# src/healthcheck.js exits 0 when the process is healthy. It is used by both the
# API and the worker; ECS also defines its own container health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/server.js"]
