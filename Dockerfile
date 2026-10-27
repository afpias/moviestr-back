FROM node:24-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
RUN yarn build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=build /app/dist ./dist
COPY src/database/migrations ./src/database/migrations
RUN mkdir -p .cache/tesseract && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
