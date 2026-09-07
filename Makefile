.PHONY: up down seed test lint fmt logs
up:    ; docker compose up -d --build
down:  ; docker compose down
seed:  ; docker compose exec kernel python -m polis_kernel.scripts.seed
logs:  ; docker compose logs -f kernel gateway
test:  ; uv run pytest -q
lint:  ; uv run ruff check . && uv run mypy packages apps
fmt:   ; uv run ruff format . && uv run ruff check --fix .
