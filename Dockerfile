# Pin runtime — node ESM bot + webhook server (listens on PIN_HTTP_PORT, default 3000)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
EXPOSE 3000
CMD ["node", "dist/bot.js"]
