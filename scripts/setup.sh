#!/bin/bash

# scripts/setup.sh — First-time project setup
#
# Run once after cloning the repository.
#
# Steps:
#   1. Install backend npm dependencies
#   2. Copy backend/.env.example to backend/.env if .env does not exist
#   3. Remind operator to fill in .env values
#   4. Run database/indexes/setup-indexes.js (requires MONGODB_URI in .env)
#
# Usage:
#   bash scripts/setup.sh
