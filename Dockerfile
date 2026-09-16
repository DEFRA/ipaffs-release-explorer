FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
ENV HOST=0.0.0.0 PORT=4317
EXPOSE 4317
CMD ["node", "src/server.mjs"]
