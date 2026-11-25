# cambista on any server: docker build -t cambista . && docker run -p 8787:8787 -v cambista:/data -e ADMIN_TOKEN=… cambista
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production CAMBISTA_DATABASE=/data/cambista.db PORT=8787
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/cli.js", "serve"]
