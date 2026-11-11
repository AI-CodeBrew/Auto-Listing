# The backend on Fly.io. Build it from the project folder, because the theme push also needs
# frontend/theme-templates:
#   fly deploy . --config backend/fly.toml --dockerfile backend/Dockerfile --ha=false
# The .dockerignore in the project folder sends only the files copied below, never .env, data or storage.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app/backend

# Python packages, then Chromium with the system libraries it needs (research opens shop pages in it).
# Playwright's own Node program needs libatomic1, which the slim image leaves out.
COPY backend/requirements.txt ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 \
 && pip install --root-user-action=ignore -r requirements.txt \
 && python -m playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY backend/app.py backend/schema.sql ./
COPY backend/pla ./pla
# The project folder (APP_ROOT) is /app, so the theme files are found at /app/frontend/theme-templates.
COPY frontend/theme-templates /app/frontend/theme-templates

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
