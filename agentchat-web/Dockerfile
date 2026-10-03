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
COPY common-server.conf.template /etc/nginx/templates-snippets/common-server.conf.template
COPY subst-snippets.sh /docker-entrypoint.d/15-subst-snippets.sh
RUN chmod +x /docker-entrypoint.d/15-subst-snippets.sh
# 自签名证书（构建时生成，SAN 含常用内网名与通配；内网用途，浏览器需手动信任）
RUN mkdir -p /etc/nginx/certs &&     apk add --no-cache openssl >/dev/null &&     openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout /etc/nginx/certs/agentchat-key.pem \
      -out /etc/nginx/certs/agentchat.pem \
      -subj "/CN=agentchat" \
      -addext "subjectAltName=DNS:agentchat,DNS:localhost,IP:127.0.0.1"
EXPOSE 80 443
