FROM python:3.11-slim
WORKDIR /app
ENV PIP_DEFAULT_TIMEOUT=120

COPY packages/core          packages/core
COPY packages/event_bus     packages/event_bus
COPY packages/registry      packages/registry
COPY packages/policy        packages/policy
COPY packages/observability packages/observability
COPY packages/llm           packages/llm
RUN pip install -e packages/core -e packages/event_bus -e packages/registry \
    -e packages/policy -e packages/observability -e packages/llm --quiet

COPY apps/kernel apps/kernel
RUN pip install -e apps/kernel --quiet

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import redis, os; r=redis.from_url(os.getenv('REDIS_URL','redis://redis:6379/0')); r.ping()" || exit 1

CMD ["python", "-m", "polis_kernel.boot"]
