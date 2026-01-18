# Use a lightweight Node.js image
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

# Generate Prisma Client
RUN npx prisma generate

# Build the project
RUN yarn build

# Runner stage
FROM node:18-alpine

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/scripts/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]

# Default command runs the API server
CMD ["node", "dist/scripts/api_server.js"]
