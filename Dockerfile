FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "src/app.mjs"]
