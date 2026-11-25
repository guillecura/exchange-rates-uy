# docker build -t exchange-rates-uy . && docker run -p 8787:8787 -v rates:/data -e ADMIN_TOKEN=… exchange-rates-uy
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production RATES_DATABASE=/data/rates.db PORT=8787
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/cli.js", "serve"]
