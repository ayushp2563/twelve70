// src/db/migrate.ts
// ============================================================================
// ONE-TIME MIGRATION SCRIPT: training_clicks.csv → MySQL user_interactions
// ============================================================================
//
// Usage: npx ts-node src/db/migrate.ts
//
// This script:
//   1. Connects to MySQL
//   2. Creates the user_interactions table (if not exists)
//   3. Imports all rows from data/training_clicks.csv
//   4. Exports a verification CSV to data/training_export.csv
//   5. Prints a comparison report
//
// The original CSV is NOT deleted — it's kept as a backup.
// ============================================================================

import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { initializeDatabase, closeDatabase } from '../config/database';
import { MySQLAdapter } from './mysqlAdapter';

async function migrate() {
  console.log('═══════════════════════════════════════════════');
  console.log('  CSV → MySQL Migration Script');
  console.log('═══════════════════════════════════════════════\n');

  // 1. Connect to MySQL
  console.log('⏳ Connecting to MySQL...');
  await initializeDatabase();

  // 2. Initialize the adapter (creates table)
  const store = new MySQLAdapter();
  await store.initialize();

  // 3. Check if data already exists
  const stats = await store.getStats();
  if (stats.totalInteractions > 0) {
    console.log(`\n⚠️  Database already contains ${stats.totalInteractions} interactions.`);
    console.log('   To re-import, manually TRUNCATE the user_interactions table first.');
    console.log('   Skipping import.\n');
  } else {
    // 4. Import CSV
    const csvPath = path.join(process.cwd(), 'data', 'training_clicks.csv');
    if (!fs.existsSync(csvPath)) {
      console.log(`\n⚠️  No CSV found at ${csvPath}. Nothing to import.\n`);
    } else {
      const csvContent = fs.readFileSync(csvPath, 'utf8');
      const csvLines = csvContent.trim().split('\n');
      console.log(`\n📄 Found ${csvLines.length} lines in CSV (including header).`);
      
      const imported = await store.importFromCSV(csvPath);
      console.log(`✅ Imported ${imported} records into user_interactions table.\n`);
    }
  }

  // 5. Export verification CSV
  console.log('⏳ Exporting verification CSV...');
  const exportPath = await store.exportForTraining();
  
  // 6. Verify
  const finalStats = await store.getStats();
  console.log('\n═══════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total interactions in DB:  ${finalStats.totalInteractions}`);
  console.log(`  Total saves:              ${finalStats.totalSaves}`);
  console.log(`  Total flags:              ${finalStats.totalFlags}`);
  console.log(`  Unique users:             ${finalStats.uniqueUsers}`);
  console.log(`  Exported CSV:             ${exportPath}`);
  console.log('═══════════════════════════════════════════════\n');

  // Cleanup
  await store.close();
  await closeDatabase();
  console.log('✅ Migration complete. You can now use the database for all interactions.');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
