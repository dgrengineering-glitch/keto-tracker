# Keto Tracker

A mobile-first, offline-capable keto macro tracker (PWA) for iPhone Safari. No accounts, no backend – all data is stored on the device (localStorage) with JSON backup/restore.

## Features
- Barcode scanning (EAN-13/EAN-8/UPC-A/UPC-E) with the iPhone camera via html5-qrcode (bundled in `vendor/`), plus manual barcode entry
- Product lookup via Open Food Facts (uk.openfoodfacts.org, falls back to world), per-100 g macros scaled to grams or servings
- UK/EU "carbs already exclude fibre" toggle per food (auto-off for US-labelled products)
- Manual foods, My foods, Recent and Frequent lists
- Daily log by meal, edit/delete, previous days
- Calorie-% targets (default 70% fat / 25% protein / 5% net carbs), dashboard rings, amber at 80% / red over the net-carb limit
- History (7/30 days), keto streak
- Body & Goals: weigh-ins (kg or st/lb; cm or ft/in), 7-day trends, Katch-McArdle TDEE (Mifflin-St Jeor for comparison), goal planner with week-by-week projection feeding the daily calorie target
- Photo (AI estimate): user's own xAI (Grok) API key (Settings, stored only in localStorage, excluded from backups), photo downscaled to ≤1024 px JPEG and sent directly to api.x.ai (Responses API, default model grok-4.3, structured JSON output, `store: false`); editable review card before adding
- Speak your food (Manual entry): records with MediaRecorder (audio/mp4 on iOS), transcribes with xAI Speech to Text (`POST /v1/stt`, grok-voice-transcribe-2.0, falls back to 1.0), decodes with Grok into the same editable review card; live dictation (SpeechRecognition) and typed/keyboard-mic fallback. Cancel button, 45 s timeouts, “Type it instead”. No OpenAI services are used anywhere.
- Scale import: URL import (`#/import?weight=82.4&bf=24.1&muscle=38.2&water=55&date=2026-09-27`, `unit=lb|st`), clipboard/paste text extraction, CSV import with column detection/mapping (`sample-scales.csv`)

## Deploy (any static host)
Upload the folder contents as-is (all paths are relative, so a subpath such as GitHub Pages `/keto-tracker/` works). Bump `VERSION` in `sw.js` on every deploy so phones pick up the update.

GitHub Pages:
```
gh repo create keto-tracker --public --source . --push
gh api -X POST repos/{owner}/keto-tracker/pages -f "source[branch]=main" -f "source[path]=/"
```
