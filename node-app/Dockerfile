FROM node:20-slim

WORKDIR /app

# Install build dependencies for native node modules (better-sqlite3, bcrypt)
# node:20-slim is Debian-based (glibc) — required for onnxruntime-node
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Set ONNX Runtime cache directory to persistent volume
ENV TRANSFORMERS_CACHE=/app/data/models

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy application code
COPY src/ ./src/

# Create directories for persistent data
RUN mkdir -p sessions data data/models

EXPOSE 3000

CMD ["node", "src/app.js"]
