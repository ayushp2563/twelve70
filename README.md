# twelve70 — Project Documentation

## What This Project Does

**twelve70** is a color-matching engine for fashion outfits. It helps users (or the app's algorithm) figure out which **top outer color** (a jacket, hoodie, or layer) looks best for a given combination of:

- **Top** (shirt/T-shirt)
- **Bottom** (pants/jeans/skirt)
- **Outerwear** (coat/blazer/windbreaker)
- **Footwear** (sneakers/boots)

The system is backed by **25,000 hand-curated outfit combinations** from the production database, which are used as the ground truth for what colors look good together.

---

## Project Structure

```
twelve70/
├── src/
│   ├── app.ts                    ← Express server entry point
│   ├── sequentialFilter.ts       ← Core color matching engine (CSV-based)
│   ├── colorMatcher.ts           ← Legacy DB-based matcher
│   ├── config/
│   │   └── database.ts           ← MySQL connection pool
│   ├── routes/
│   │   ├── colorMatching.ts      ← Outfit filter API routes
│   │   └── dbExplorer.ts         ← Database browser API routes
│   ├── middleware/
│   │   └── colorCaching.ts       ← Response caching
│   └── tests/
│       └── colorMatcher.test.ts
│
├── public/
│   ├── index.html                ← Admin dashboard
│   ├── outfit-builder.html       ← Interactive outfit builder UI
│   └── db-explorer.html          ← Database table browser UI
│
├── scripts/
│   └── generate_predictions.ts   ← Batch CSV prediction script
│
├── data/
│   ├── colorcombos.csv           ← 25,000 outfit combinations (source of truth)
│   ├── colorcombos_with_predictions.csv  ← Generated predictions output
│   ├── colorshex.csv             ← Color name → hex code mapping
│   └── colors.csv                ← Color reference list
│
├── SchemaDump20260506_clean.sql  ← Production DB schema (57 tables)
├── docker-compose.yml            ← Local MySQL + phpMyAdmin
├── .env                          ← Environment variables
├── package.json
└── tsconfig.json
```

---

## How to Run

```bash
# 1. Start the local database
docker compose up -d

# 2. Start the API server
npm run dev

# 3. Open in browser
#    Admin dashboard:   http://localhost:3000/
#    Outfit Builder UI: http://localhost:3000/outfit-builder.html
#    DB Explorer:       http://localhost:3000/db-explorer.html
#    phpMyAdmin:        http://localhost:8081/

# 4. Generate predictions for the CSV (batch job)
npm run predict
```

---

## How the Sequential Filter Works

### The Core Idea

Instead of predicting everything at once, the system works **step by step**. Each garment the customer picks **narrows down** which colors make sense for the next garment.

```
Customer picks TOP COLOR
    ↓  (filters based on data + scores)
Customer picks BOTTOM COLOR
    ↓  (narrows further)
Customer picks OUTERWEAR COLOR
    ↓  (narrows further)
Customer picks FOOTWEAR COLOR
    ↓
Algorithm predicts TOP OUTER COLOR
```

At every step, the returned options are:
1. **Pulled from real outfit data** — only colors that actually appear with the selected garments
2. **Ranked by a scoring algorithm** — better matches appear first with a score 0–100

### The Four Step Functions

| Function | What it does |
|----------|-------------|
| `getAllTopColors()` | Returns all distinct top colors in the dataset, sorted by frequency |
| `getBottomOptions(topColor)` | Finds all bottoms that appear with that top in real data, scored |
| `getOuterwearOptions(topColor, bottomColor)` | Finds outerwear options for that top+bottom combo, scored |
| `getFootwearOptions(topColor, bottomColor, outerwear)` | Finds footwear for that 3-garment combo, scored |

**Fallback mechanism**: If fewer than 3 options are found (e.g., very rare combination), the filter automatically relaxes — it drops one constraint and searches more broadly. This prevents dead-ends.

---

## How Colors Are Compared — The Scoring System

Every candidate color receives a **score from 0 to 100** built from 6 independent factors:

### Factor 1: Database Frequency (max 30 pts)

> "Colors that real stylists have paired together many times are likely good choices."

```
frequency × 3 pts, capped at 30
e.g., if this combo appears 8 times → 24 pts
      if it appears 15+ times       → 30 pts
```

This is the most important factor because it's grounded in **real human curation**, not just theory.

### Factor 2: Color Family Harmony (max 25 pts)

> "Colors in harmonious families look good next to each other."

Each color is classified into one of 6 families:

| Family | Colors |
|--------|--------|
| **NEUTRAL** | black, white, grey, charcoal, tan, camel, sand, brown, tobacco |
| **WARM** | red, burgundy, orange, yellow, mustard, burnt orange, gold |
| **COOL** | blue, navy, teal, turquoise, purple, mint, lavender |
| **EARTH** | olive green, forest green, khaki, green |
| **PASTEL** | light pink, dusty pink, hot pink, coast |
| **PATTERN** | camo, tartan, houndstooth, plaid, gingham |

**Harmony rules** (which families pair well):
- **NEUTRAL** → works with everything (+25 pts if same family, +18 if harmonious)
- **WARM** → good with NEUTRAL, COOL, EARTH
- **COOL** → good with NEUTRAL, WARM, EARTH, PASTEL
- **EARTH** → good with NEUTRAL, COOL, PASTEL, WARM
- **PASTEL** → good with NEUTRAL, COOL, EARTH
- **PATTERN** → pairs with NEUTRAL, COOL, EARTH (avoid stacking two patterns)

**Scoring**:
```
Same family as outerwear     → +25 pts
Harmonious with outerwear    → +18 pts
Clashes with outerwear       → -15 pts
```

### Factor 3: Contrast Balance with Top (max 20 pts)

> "The jacket should contrast nicely with the shirt, not be invisible on top of it."

```
Same family as top      → +10 pts (matching, subtle)
Harmonious with top     → +20 pts (contrast, more visual interest)
```

This intentionally rewards **contrast** over exact matching, because a jacket that contrasts with the shirt looks intentional.

### Factor 4: Tone Consistency with Bottom (max 15 pts)

> "The layering piece shouldn't fight with the pants."

```
Harmonious with bottom  → +15 pts
Clashes with bottom     → -10 pts
```

### Factor 5: Neutral Bonus (max 10 pts)

> "When in doubt, neutrals always work."

```
If candidate is in NEUTRAL family → +10 pts
```

This gives neutrals a safe-harbor advantage, which mirrors real fashion advice (black jacket always works).

### Factor 6: Pattern Complexity Penalty

> "Don't mix too many patterns — it looks chaotic."

```
If candidate is PATTERN and another garment is already PATTERN → -20 pts
```

This prevents the algorithm from suggesting a tartan jacket when the outerwear is already a camo.

---

## Prediction Matching Strategy

When predicting `top_outer_color`, the engine tries 3 levels:

```
Level 1: EXACT MATCH
  → Find rows where all 4 garments match exactly
  → Use those top_outer_color values, ranked by score
  → Match type: "exact" (highest confidence)

Level 2: PARTIAL MATCH
  → Relax: match only top + outerwear color
  → Score the results
  → Match type: "partial" (medium confidence)

Level 3: FAMILY SCORING
  → Use all 25,000 rows with known top_outer_color
  → Score each candidate purely by color family harmony
  → Match type: "scored" (lower confidence but always gives an answer)
```

---

## API Endpoints Reference

### Sequential Filter (CSV-based, no DB required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/outfit/step/tops` | All top colors with frequency |
| GET | `/api/outfit/step/bottom?topColor=black` | Ranked bottom options |
| GET | `/api/outfit/step/outerwear?topColor=&bottomColor=` | Ranked outerwear options |
| GET | `/api/outfit/step/footwear?topColor=&bottomColor=&outerwearColor=` | Ranked footwear options |
| POST | `/api/outfit/predict-outer` | Predict top_outer_color (body: all 4 colors) |

### Database Explorer

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/db/tables` | List all tables with row counts |
| GET | `/api/db/tables/:table/schema` | Columns + indexes |
| GET | `/api/db/tables/:table/rows` | Paginated rows with search |
| GET | `/api/db/tables/:table/export` | Download as CSV |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Total colors + combos |
| GET | `/api/admin/combos` | Search outfit combos |
| POST | `/api/admin/combos` | Add a new combo |
| POST | `/api/outfit/suggest-outer-color` | Legacy DB-based matcher |

---

## Key Files Explained

| File | Purpose |
|------|---------|
| `src/sequentialFilter.ts` | The entire matching engine — loads CSV, scores colors, exposes step functions |
| `src/colorMatcher.ts` | Older DB-based matcher, still used by legacy endpoint |
| `scripts/generate_predictions.ts` | Batch-processes the 25k CSV and fills in missing `top_outer_color` values |
| `data/colorcombos.csv` | The source-of-truth dataset (never modified) |
| `data/colorcombos_with_predictions.csv` | Output of the batch script with 4 added columns |
| `data/colorshex.csv` | Maps color names to hex codes for the UI |
| `SchemaDump20260506_clean.sql` | Full production DB schema — 57 tables |

---

## Environment Variables

```env
DB_HOST=localhost
DB_PORT=3307          # Docker maps MySQL 3306 → host 3307
DB_USER=myuser
DB_PASSWORD=mypass
DB_NAME=mydb
API_PORT=3000
```
