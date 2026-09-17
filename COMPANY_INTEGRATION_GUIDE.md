# Twelve70 — Company Integration Guide

**Audience:** Twelve70 engineering team integrating this recommendation system into the production product.  
**Assumption:** Nothing from this repository has been integrated yet.  
**Goal:** Ship top-outer color generation, any-sequence outfit picking, ML re-ranking, click feedback, and monthly profile rollup — in a safe, phased order.

---

## What You Are Integrating

This repo is a complete **outfit color recommendation engine**. Given garment colors, it recommends (or re-ranks) compatible colors for other slots — especially the **top outer / midlayer** color.

| Capability | What it does | Core files |
|---|---|---|
| **Sequential filter** | User picks Top → Bottom → Outerwear → Footwear; system predicts Top Outer | `src/sequentialFilter.ts`, `src/routes/colorMatching.ts` |
| **Any-sequence filter** | User picks garments in **any order**; remaining slots update live | `src/anySequenceFilter.ts`, `src/routes/anySequenceMatching.ts` |
| **ML re-ranker** | LightGBM model (ONNX) re-ranks rule-engine candidates in-process | `src/ml/inference.ts`, `models/outfit_ranker.onnx`, `ml_pipeline/train.py` |
| **Click / save history** | Persists user saves & flags for training + personalization | `src/db/*`, `POST /api/outfit/save` |
| **Monthly profile rollup** | Summarizes old clicks into compact profiles, archives raw rows, keeps DB small | `src/ml/profileRollupScheduler.ts`, `user_profile_summaries` table |

Architecture (always keep this picture in mind):

```
User selections
      │
      ▼
┌─────────────────────────────┐
│ Stage 1: Retrieval          │  SequentialFilter / AnySequenceFilter
│ (rule + graph engine)       │  Enforces brand rules, filters clashes
└─────────────┬───────────────┘
              │ candidates (safe list)
              ▼
┌─────────────────────────────┐
│ Stage 2: ML Re-Ranker       │  LightGBM via ONNX Runtime (Node.js)
│ (optional, falls back safe) │  ~1–2 ms; never blocks if model missing
└─────────────┬───────────────┘
              │ ranked results + reasons
              ▼
         Product UI / API
              │
              ▼ (user saves / flags)
┌─────────────────────────────┐
│ Feedback store              │  Hot table: last ~30 days of clicks
│ + monthly profile rollup    │  Summaries: personalization context
│ + disk archives             │  Archives: full history for retraining
└─────────────────────────────┘
```

**Important:** Stage 1 alone is a complete product. Stage 2 and feedback improve ranking and personalization over time. Integrate Stage 1 first.

---

## Recommended Integration Order

Do **not** integrate everything at once. Follow these phases:

| Phase | What to ship | Why this order | Rough effort |
|---|---|---|---|
| **1** | Sequential top-outer prediction | Core business value; no DB/ML required | 1–2 weeks |
| **2** | Any-sequence picker | Product flexibility; reuses same data | 3–5 days |
| **3** | ML re-ranker (ONNX) | Latency + ranking quality on top of Phase 1–2 | 3–5 days |
| **4** | Save / flag click history | Training + analytics foundation | 2–4 days |
| **5** | Profile rollup + personalization | Resource control + per-user affinity | 2–3 days |

Phases 1–2 can go to production without ML or a feedback DB. Phases 3–5 layer on without changing the public API contract for garment selection.

---

## Prerequisites

### Runtime

- **Node.js** 18+ (Express 5 API)
- **Python** 3.10+ with virtualenv (only for training / exporting ONNX — not required at serve time)
- **MySQL** 8.0+ (only from Phase 4 onward; Phases 1–2 run on CSV alone)
- Optional: Docker for a local MySQL + phpMyAdmin stack (`docker-compose.yml`)

### Data files you must ship with the service

Copy these into your deployment package (paths relative to process cwd):

```
data/
  colorcombos.csv          # ~25k curated outfit combinations (source of truth)
  colors.csv               # Color catalog + alias definitions
  colorshex.csv            # Color name → hex mapping
public/
  patterns/                # Optional pattern PNG assets referenced by name
models/
  outfit_ranker.onnx       # Phase 3+ — trained LightGBM ranker
```

Without `colorcombos.csv` + `colorshex.csv`, the engines cannot initialize.

### Environment variables

```bash
# Server
API_PORT=3000

# MySQL (Phase 4+)
DB_HOST=localhost
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
DB_ADAPTER=mysql            # or implement a company adapter (see Phase 4)

# Retraining (Phase 4+)
RETRAIN_ENABLED=true
RETRAIN_CRON=0 2 * * *      # daily 2 AM
RETRAIN_MIN_NEW=10

# Profile rollup (Phase 5)
PROFILE_ROLLUP_ENABLED=true
PROFILE_RETENTION_DAYS=30
PROFILE_ROLLUP_HOURS=24
```

---

## Phase 1 — Sequential Top-Outer Color Logic

### What to integrate

1. `src/sequentialFilter.ts` — CSV-backed scoring engine  
2. `src/aliasResolver.ts` (or the resolver embedded in the filter)  
3. Routes under `/api/outfit/step/*` and `POST /api/outfit/predict-outer` from `src/routes/colorMatching.ts`  
4. Optional UI reference: `public/outfit-builder.html`

### How it works

```
GET  /api/outfit/step/tops
GET  /api/outfit/step/bottom?topColor=black
GET  /api/outfit/step/outerwear?topColor=black&bottomColor=charcoal
GET  /api/outfit/step/footwear?topColor=black&bottomColor=charcoal&outerwearColor=camel
POST /api/outfit/predict-outer
     body: { topColor, bottomColor, outerwearColor, footwearColor,
             occasion?, vibe?, fitType? }
```

Response shape for predict:

```json
{
  "success": true,
  "data": {
    "primary": {
      "color": "charcoal",
      "hex": "#4d4d4d",
      "score": 77.5,
      "frequency": 1,
      "reasons": ["...", "..."],
      "explanation": "..."
    },
    "alternatives": [ /* same shape */ ],
    "matchType": "exact"
  },
  "meta": { "responseTime": "12ms" }
}
```

### Integration steps (company codebase)

1. **Copy / vendor** the filter module and its data files into your service.  
2. **Initialize once at process start** (same pattern as `src/app.ts`):

   ```ts
   import { engine } from './sequentialFilter';
   await engine.initialize(process.cwd()); // loads colorcombos.csv
   ```

3. **Expose the step + predict APIs** behind your auth/gateway.  
4. **Wire your product UI** to call steps sequentially, then `predict-outer`.  
5. **Smoke test:** Black → Charcoal → Camel → Black should return a ranked midlayer (typically charcoal / black / navy family) with human-readable reasons.

### Acceptance criteria for Phase 1

- [ ] Server starts and logs ~25k combos loaded  
- [ ] All four step endpoints return ranked options  
- [ ] `predict-outer` returns primary + alternatives with scores and reasons  
- [ ] Works **without** MySQL and **without** the ONNX model  

---

## Phase 2 — Any-Sequence Logic

### What to integrate

1. `src/anySequenceFilter.ts`  
2. Route `POST /api/any-sequence/options` from `src/routes/anySequenceMatching.ts`  
3. Optional UI: `public/any-sequence-builder.html`

### How it works

Unlike sequential mode, the client sends **whatever is currently selected**. The engine returns ranked options for **all five slots** given that partial context.

```
POST /api/any-sequence/options
body: {
  selections: {
    topColor?: string,
    bottomColor?: string,
    outerwearColor?: string,
    footwearColor?: string,
    topOuterColor?: string
  },
  occasion?: string,
  vibe?: string,
  fitType?: string
}
```

Example: user picks footwear first → Top / Bottom / Outerwear / Top Outer all re-rank against white shoes (sandwich anchoring, pairwise graph scores).

### Integration steps

1. Initialize alongside the sequential engine:

   ```ts
   import { anySequenceEngine } from './anySequenceFilter';
   await anySequenceEngine.initialize(process.cwd());
   ```

2. Mount the any-sequence route.  
3. In the product UI, call `/api/any-sequence/options` on every selection change (debounce ~100–200 ms).  
4. Keep Sequential Mode as a simpler flow for first-time users if desired.

### Acceptance criteria for Phase 2

- [ ] Selecting only footwear returns non-empty options for other slots  
- [ ] Deselecting a garment recalculates remaining options  
- [ ] Still works without ML / without DB  

---

## Phase 3 — ML Model (ONNX Re-Ranker)

### What to integrate

1. `src/ml/inference.ts` — ONNX session + hybrid re-rank  
2. `src/ml/featureExtractor.ts` — feature vector for each candidate  
3. `models/outfit_ranker.onnx` — production model artifact  
4. Dependency: `onnxruntime-node`  
5. Training pipeline (ops, not serve-time): `ml_pipeline/train.py`, `requirements.txt`

### How it works

After Stage 1 returns candidates, the re-ranker:

1. Builds a 9-float feature vector per candidate (`FEATURE_NAMES` in `featureExtractor.ts`)  
2. Runs a batch ONNX inference  
3. Blends scores: **40% rule-engine score + 60% ML utility**  
4. If the model is missing, mock, or flat-score → **falls back to Stage 1 order** (safe)

### Integration steps

1. Install `onnxruntime-node` in the Node service.  
2. Place `models/outfit_ranker.onnx` next to the process cwd.  
3. At startup:

   ```ts
   import { mlRanker } from './ml/inference';
   await mlRanker.initialize();
   // Look for: "✅ Machine Learning Re-Ranking Engine ... initialized"
   ```

4. Keep the existing call sites in `predict-outer` and `/api/any-sequence/options` that call `mlRanker.reRankCandidates(...)` when `mlRanker.isEnabled()`.  
5. **Feature parity rule:** if you change `featureExtractor.ts`, you **must** update `ml_pipeline/features.py` the same way and retrain. Run:

   ```bash
   npx jest src/tests/featureParity.test.ts
   ```

### Training / re-exporting the model

On a machine with the Python venv:

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Build training clicks / export first (Phase 4), then:
python ml_pipeline/train.py
# Writes models/outfit_ranker.onnx
```

For the offline midlayer **classifier** research model (not the live ONNX ranker):

```bash
python train_baseline.py            # or ml_pipeline/train_baseline.py
python ml_pipeline/optimize_hyperparameters.py
```

### Acceptance criteria for Phase 3

- [ ] Startup log shows ONNX initialized (not “fallback / mock”)  
- [ ] `predict-outer` still succeeds if you rename the model file away (fallback)  
- [ ] Latency remains well under your product SLA (target: total API &lt; 50 ms)  
- [ ] Feature parity test passes  

---

## Phase 4 — Click History (Save / Flag)

Integrate this **after** Phases 1–3 are live in staging. Feedback without a working recommender is useless; a recommender without feedback cannot personalize.

### What to integrate

1. `src/db/types.ts` — `InteractionStore` contract  
2. `src/db/mysqlAdapter.ts` — MySQL implementation  
3. `src/db/index.ts` — adapter factory (`DB_ADAPTER`)  
4. Routes: `POST /api/outfit/save`, flag routes, interaction stats  
5. `src/ml/retrainingScheduler.ts` — scheduled retrain from stored interactions  

### Schema created automatically on boot

`user_interactions` (created by `MySQLAdapter.initialize()`):

| Column | Purpose |
|---|---|
| `user_id` | Your auth user id (string — UUID, int-as-string, etc.) |
| `action` | `save` or `flag` |
| `top_color` … `top_outer_color` | Outfit colors |
| `interaction_score` | `2` = save, `0` = flag |
| `confidence_score`, `model_version` | Optional ML metadata |
| `vibe`, `occasion`, `fit_type` | Optional context |
| `created_at` | Timestamp |

### API your product must call

```
POST /api/outfit/save
body: {
  userId: "<real auth id>",          // required for personalization — do not leave anonymous in prod
  topColor, bottomColor, outerwearColor, footwearColor, topOuterColor,
  interactionScore?: 2,
  vibe?, occasion?, fitType?,
  confidenceScore?, modelVersion?
}
```

Also expose (or map to your admin tools):

```
GET  /api/interactions/stats
GET  /api/interactions/user/:userId
DELETE /api/interactions/user/:userId     # GDPR
GET  /api/admin/retraining/status
POST /api/admin/retraining/trigger
```

### Company DB adapter (recommended for production)

If you do not want to use the bundled MySQL adapter:

1. Implement `InteractionStore` from `src/db/types.ts` against your DB.  
2. Register it in `src/db/index.ts` under e.g. `case 'company':`.  
3. Set `DB_ADAPTER=company`.  
4. **No route or ML code changes required.**

### Retraining loop

Nightly (default):

1. Export interactions → `data/training_export.csv` (includes archives from Phase 5)  
2. Run `ml_pipeline/train.py`  
3. Hot-reload ONNX session  

Do **not** retrain on every save in production; use the scheduler.

### Acceptance criteria for Phase 4

- [ ] Save from product UI persists a row keyed by real `userId`  
- [ ] Stats endpoint reflects new saves  
- [ ] Manual `POST /api/admin/retraining/trigger` produces a new ONNX file when enough data exists  
- [ ] GDPR delete removes that user’s rows  

---

## Phase 5 — Monthly Profile Rollup (Resource Control + Personalization)

Integrate **last**. It depends on Phase 4 having real click volume.

### Why this exists

Keeping every click forever in the hot DB grows cost and slows queries. This feature:

1. **Summarizes** clicks older than N days (default 30) into compact per-user monthly profiles  
2. **Archives** raw rows to `data/archive/interactions_YYYY-MM.csv` (cheap disk)  
3. **Prunes** those rows from the hot `user_interactions` table  
4. Uses the profile as **`userColorAffinity`** during ML re-ranking for next-month recommendations  

Raw data is **not destroyed** — archives are merged back into training exports. Summaries are what stay in MySQL for fast personalization.

### What to integrate

1. Rollup methods on `InteractionStore` (`rollupOldInteractions`, `getUserProfile`) — already in `mysqlAdapter.ts`  
2. Table `user_profile_summaries` (auto-created)  
3. `src/ml/profileRollupScheduler.ts`  
4. Routes:
   - `GET /api/users/:userId/profile`
   - `GET /api/admin/rollup/status`
   - `POST /api/admin/rollup/trigger`
5. Pass `userId` into `POST /api/outfit/predict-outer` so affinity is applied

### Profile response example

```json
{
  "success": true,
  "profile": {
    "userId": "user_123",
    "monthsSummarized": 2,
    "totalSaves": 40,
    "totalFlags": 3,
    "colorAffinity": { "black": 0.55, "navy": 0.25, "brown": 0.20 },
    "favoriteColors": ["black", "navy", "brown"],
    "contextPreferences": {
      "vibe": "minimalist",
      "occasion": "casual",
      "fitType": "fitted"
    }
  }
}
```

### Ops checklist

- [ ] Set `PROFILE_RETENTION_DAYS` (30 is a good default)  
- [ ] Ensure `data/archive/` is on persistent disk / backed-up volume  
- [ ] Confirm training export still includes archived rows after a rollup  
- [ ] Product sends `userId` on **both** save and predict  

### Acceptance criteria for Phase 5

- [ ] Manual rollup prunes old rows and creates/updates a summary  
- [ ] Archive CSV exists for the pruned month  
- [ ] `GET /api/users/:id/profile` returns affinities  
- [ ] Predict with `userId` uses profile affinity (feature extractor no longer stuck at 0.8 for that user)  

---

## End-to-End Wiring Checklist (Production)

Use this as the final “go live” list once all phases are done:

### Backend service

- [ ] CSV engines initialize on boot  
- [ ] ONNX model loads (or explicit safe fallback)  
- [ ] MySQL (or company adapter) initializes `user_interactions` + `user_profile_summaries`  
- [ ] Retraining scheduler enabled with monitored cron  
- [ ] Profile rollup scheduler enabled with monitored retention  
- [ ] Health check verifies: CSV loaded, DB reachable, model status  

### Product client

- [ ] Sequential and/or any-sequence UI calls the documented APIs  
- [ ] Authenticated `userId` sent on save **and** predict  
- [ ] Save / flag buttons call feedback endpoints  
- [ ] Errors fall back gracefully (empty options → show neutrals / previous selection)

### ML ops

- [ ] Python venv + `requirements.txt` available in CI or a training job  
- [ ] Feature parity test runs in CI when extractors change  
- [ ] Model artifacts versioned (`outfit_ranker_vN.onnx` recommended before scale)  
- [ ] Alert if retraining fails or ONNX fails to load  

### Security / compliance

- [ ] Admin retraining/rollup endpoints protected (auth / VPN / admin role)  
- [ ] GDPR delete wired to your account-deletion flow  
- [ ] Archive directory access restricted  

---

## File Map — What to Copy vs Leave Behind

### Must integrate (runtime)

```
src/sequentialFilter.ts
src/anySequenceFilter.ts
src/aliasResolver.ts          # if separate in your tree
src/ml/inference.ts
src/ml/featureExtractor.ts
src/ml/retrainingScheduler.ts
src/ml/profileRollupScheduler.ts
src/db/types.ts
src/db/index.ts
src/db/mysqlAdapter.ts        # or your company adapter
src/routes/colorMatching.ts   # or equivalent route wiring
src/routes/anySequenceMatching.ts
data/colorcombos.csv
data/colors.csv
data/colorshex.csv
models/outfit_ranker.onnx
package.json dependencies: express, onnxruntime-node, mysql2, dotenv, ...
```

### Keep for ops / ML team (not customer-facing)

```
ml_pipeline/*
train_baseline.py
requirements.txt
scripts/generate_predictions.ts
error_analysis_report.json / company_summary_report.md
```

### Reference UIs (optional — replace with your design system)

```
public/outfit-builder.html
public/any-sequence-builder.html
```

---

## Suggested Company Rollout Timeline

| Week | Milestone |
|---|---|
| 1–2 | Phase 1 in staging; product QA on sequential predict |
| 3 | Phase 2 any-sequence in staging |
| 4 | Phase 3 ONNX in staging; latency + fallback drills |
| 5 | Phase 1–3 behind feature flag in production (alpha / office) |
| 6 | Phase 4 click logging with real `userId` |
| 7 | Collect volume; enable scheduled retrain |
| 8+ | Phase 5 rollup once you have &gt;30 days of clicks |

---

## Common Pitfalls

1. **Integrating the model before Stage 1** — the model only re-ranks Stage 1 candidates; without the filter you have nothing safe to show.  
2. **Leaving `userId` as `anonymous`** — rollup and personalization collapse all users into one profile.  
3. **Deleting raw clicks without archives** — permanently damages the training set. Use the built-in summarize → archive → prune path.  
4. **Changing TS features without Python + retrain** — silent ranking degradation. Always run the parity test.  
5. **Retraining on every save** — unstable model + wasted CPU. Use the cron scheduler.  
6. **Expecting 99% accuracy to mean “better fashion taste”** — that number largely measures fidelity to the curated rule engine. Real quality comes from human click feedback over time.

---

## Support Contacts Inside This Repo

| Question | Look here |
|---|---|
| How does scoring work? | `src/sequentialFilter.ts`, `EXPLANATION_SCORING_SYSTEM.md` |
| How good is the model today? | `company_summary_report.md`, `error_analysis_report.json` |
| How do I retrain? | `ml_pipeline/train.py`, `src/ml/retrainingScheduler.ts` |
| How do profiles / retention work? | `src/ml/profileRollupScheduler.ts`, `src/db/mysqlAdapter.ts` (`rollupOldInteractions`) |
| Local demo URLs | `http://localhost:3000/outfit-builder.html`, `/any-sequence-builder.html` |

---

## One-Page “Start Here” for the First Engineer

```bash
# 1. Clone / vendor this repo (or the modules listed above)
# 2. Install Node deps
npm install

# 3. Ensure data/ CSVs are present
# 4. Start (Phases 1–2 work without Docker)
npm run build && npm start

# 5. For Phases 4–5, start MySQL
docker compose up -d

# 6. Verify
curl -X POST http://localhost:3000/api/outfit/predict-outer \
  -H 'Content-Type: application/json' \
  -d '{"topColor":"black","bottomColor":"charcoal","outerwearColor":"camel","footwearColor":"black"}'
```

If that returns `success: true` with a primary color and reasons, Stage 1 is integrated correctly. Then proceed Phase 2 → 3 → 4 → 5 in order.
