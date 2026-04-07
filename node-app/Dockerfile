FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native node modules (better-sqlite3, bcrypt)
RUN apk add --no-cache python3 make g++

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy application code
COPY src/ ./src/

# Create directories for persistent data
RUN mkdir -p sessions data

EXPOSE 3000

CMD ["node", "src/app.js"]
