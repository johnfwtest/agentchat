FROM node:20-alpine AS build
WORKDIR /app
# npm 镜像地址可配（构建参数）：--build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json ./
RUN npm install --registry=${NPM_REGISTRY}
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
