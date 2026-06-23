# Backend API + Agent Control Center + all engines (OCR, Knowledge Base, Gmail,
# Lead Conversion, Workflow Auditor). One Node process serving /api and /app.
#
# Provider-independent: a plain Node image + the OS packages the OCR engine needs
# (tesseract rus+eng, poppler for PDF text/render). No cloud-specific anything.
FROM node:20-bookworm-slim

# OCR + PDF tooling used by documentUnderstandingService / extractionReviewService.
# zip/unzip are required by the mockup DOCX fill engine (mockupAgentService.fillTemplate).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
      poppler-utils \
      zip unzip \
      ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

# Install production dependencies first (better layer caching).
# The backend never launches a browser (WhatsApp/Chromium runs in its own image), so
# skip puppeteer's Chromium download here — faster build, smaller image.
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code + the static Control Center frontend.
# server.js resolves the frontend at ../../frontend, so it must live at /app/frontend.
COPY backend/ ./
COPY frontend/ /app/frontend/

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Liveness: the app keeps serving (and reports db state) even if Mongo is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

# tini = proper PID 1 (signal handling, zombie reaping).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
