# 分句服务。模型权重在 build 时下载并烘进镜像，运行时不联网。
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 把权重烘进来：否则第一个请求要现场下载（容器还要有外网）。
RUN python -c "from wtpsplit_lite import SaT; SaT('sat-3l-sm')"

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
