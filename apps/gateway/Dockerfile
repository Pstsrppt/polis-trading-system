FROM python:3.11-slim
WORKDIR /app
ENV PIP_DEFAULT_TIMEOUT=120

COPY packages/event_bus packages/event_bus
RUN pip install -e packages/event_bus --quiet

COPY apps/gateway apps/gateway
RUN pip install -e apps/gateway --quiet

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "polis_gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
