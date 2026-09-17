import express from 'express';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { initializeDatabase, closeDatabase } from './config/database';
import { setupColorMatchingEndpoint } from './routes/colorMatching';
import { setupDbExplorerRoutes } from './routes/dbExplorer';
import { setupAnySequenceRoutes } from './routes/anySequenceMatching';
import { engine } from './sequentialFilter';
import { anySequenceEngine } from './anySequenceFilter';
import { mlRanker } from './ml/inference';
import { flagger } from './flaggingSystem';
import { createInteractionStore } from './db';
import { retrainingScheduler } from './ml/retrainingScheduler';
import { profileRollupScheduler } from './ml/profileRollupScheduler';


const app = express();

// Middleware
app.use(express.json());
const publicPath = path.join(process.cwd(), 'public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

async function start() {
  try {
    // ── 1. Load CSV engine (no DB needed) ─────────────────────────────────
    console.log('⏳ Loading colour data from CSV…');
    await engine.initialize(process.cwd());
    await anySequenceEngine.initialize(process.cwd());
    
    // Load ML Ranker
    await mlRanker.initialize();

    // ── 2. Try database (non-fatal if unavailable) ─────────────────────────
    try {
      await initializeDatabase();
      await flagger.syncDatabaseTable();

      // ── 2b. Initialize InteractionStore (user interactions DB) ──────────
      const store = createInteractionStore();
      await store.initialize();

      // One-time migration: import existing CSV data into the DB
      const csvPath = path.join(process.cwd(), 'data', 'training_clicks.csv');
      if (fs.existsSync(csvPath)) {
        const stats = await store.getStats();
        if (stats.totalInteractions === 0) {
          console.log('📦 Migrating existing training_clicks.csv into database...');
          const imported = await store.importFromCSV(csvPath);
          console.log(`✅ Migrated ${imported} records. CSV file preserved as backup.`);
        }
      }

      // ── 2c. Start profile rollup scheduler (needs the InteractionStore) ──
      profileRollupScheduler.start();
    } catch (dbErr) {
      console.warn('⚠️  Database unavailable — DB-backed routes will return errors, CSV routes still work.');
    }

    // ── 2d. Start retraining scheduler ────────────────────────────────────
    retrainingScheduler.start();

    // ── 3. Register routes ─────────────────────────────────────────────────
    setupColorMatchingEndpoint(app);
    setupDbExplorerRoutes(app);
    setupAnySequenceRoutes(app);


    // ── 4. Start listening ─────────────────────────────────────────────────
    const PORT = process.env.API_PORT || 3000;
    app.listen(PORT, () => {
      console.log(`\n🚀 Server running → http://localhost:${PORT}`);
      console.log(`   Admin dashboard  → http://localhost:${PORT}/`);
      console.log(`   Outfit Builder   → http://localhost:${PORT}/outfit-builder.html\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully…');
  retrainingScheduler.stop();
  profileRollupScheduler.stop();
  await closeDatabase();
  process.exit(0);
});

start();

export default app;