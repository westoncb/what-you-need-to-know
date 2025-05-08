#!/usr/bin/env bash
set -e
D=$(date +%F)
git add frontend/public/$D.json
git commit -m "Add daily MMGE report $D"
git push origin main
