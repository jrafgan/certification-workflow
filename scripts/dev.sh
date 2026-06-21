#!/bin/bash

# scripts/dev.sh — Start development server
#
# Starts the backend with nodemon for live reload.
# The backend serves frontend static files from ../frontend.
# Open http://localhost:3000 in a browser after starting.
#
# Requires:
#   - backend/.env with valid MONGODB_URI and PORT
#   - npm install completed (run scripts/setup.sh first)
#
# Usage:
#   bash scripts/dev.sh
