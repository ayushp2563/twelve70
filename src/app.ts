import express from 'express';
import path from 'path';
import 'dotenv/config';
import { initializeDatabase, closeDatabase } from './config/database';
import { setupColorMatchingEndpoint } from './routes/colorMatching';
import { setupDbExplorerRoutes } from './routes/dbExplorer';
import { engine } from './sequentialFilter';


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

    // ── 2. Try database (non-fatal if unavailable) ─────────────────────────
    try {
      await initializeDatabase();
    } catch (dbErr) {
      console.warn('⚠️  Database unavailable — DB-backed routes will return errors, CSV routes still work.');
    }

    // ── 3. Register routes ─────────────────────────────────────────────────
    setupColorMatchingEndpoint(app);
    setupDbExplorerRoutes(app);


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
  await closeDatabase();
  process.exit(0);
});

start();

export default app;