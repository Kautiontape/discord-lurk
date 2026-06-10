FROM python:3.12-alpine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py clean.py archive.py discord_api.py ./
COPY static ./static

ENV PYTHONUNBUFFERED=1
ENV LURK_DATA_DIR=/app/data
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
