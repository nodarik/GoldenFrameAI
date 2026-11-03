FROM node:22-slim
WORKDIR /app

# Video inspections shell out to ffmpeg (server/video/frames.ts); node:22-slim has none.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production DATA_DIR=/data API_PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
