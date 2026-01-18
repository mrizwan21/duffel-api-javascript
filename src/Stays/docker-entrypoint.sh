#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Starting application..."
# Execute the command passed to the docker container
exec "$@"