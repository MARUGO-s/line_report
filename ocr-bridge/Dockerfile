FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ndl-lab/ndlocr-lite /opt/ndlocr-lite

RUN pip install -r /opt/ndlocr-lite/requirements.txt

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt
COPY app.py /app/app.py

ENV NDLOCR_WORKDIR=/opt/ndlocr-lite/src \
    NDLOCR_COMMAND="python3 ocr.py" \
    NDLOCR_DEVICE=cpu \
    NDLOCR_TIMEOUT_SEC=60 \
    MAX_UPLOAD_BYTES=10485760

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
