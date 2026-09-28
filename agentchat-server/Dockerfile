FROM python:3.12-slim
WORKDIR /app
# pip 镜像地址可配（构建参数）：--build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
# 也可在 compose 的 build.args 或 .env 里设置（见 docker-compose.yml backend 段）。
# 纯 HTTP 内网源须同时设 PIP_TRUSTED_HOST（pip 安全机制会忽略不信任的 http 源）：
#   PIP_INDEX_URL=http://192.168.1.10:8081/simple
#   PIP_TRUSTED_HOST=192.168.1.10:8081
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
COPY requirements.txt .
RUN if [ -n "$PIP_TRUSTED_HOST" ]; then \
        pip install --no-cache-dir -i ${PIP_INDEX_URL} --trusted-host ${PIP_TRUSTED_HOST} -r requirements.txt; \
    else \
        pip install --no-cache-dir -i ${PIP_INDEX_URL} -r requirements.txt; \
    fi
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
