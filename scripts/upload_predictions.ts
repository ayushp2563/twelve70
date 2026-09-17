#!/usr/bin/env ts-node
/**
 * ============================================================================
 * PREDICTED DATA UPLOADER SCRIPT
 * ============================================================================
 *
 * Reads colorcombos_with_predictions.csv and uploads it to a dedicated table:
 * `color_combos_with_predictions` in MySQL for easy viewing in the DB Explorer.
 *
 * Usage:
 *   npx ts-node scripts/upload_predictions.ts
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import 'dotenv/config';
import { pool, initializeDatabase, closeDatabase } from '../src/config/database';

const ROOT  = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'data', 'colorcombos_with_predictions.csv');

function progress(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  return `[${bar}] ${pct}% (${current}/${total})`;
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   twelve70 — Predictions DB Uploader     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (!fs.existsSync(INPUT)) {
    console.error(`❌ Input predicted CSV not found at: ${INPUT}`);
    console.log('   Please run: npm run predict first.');
    process.exit(1);
  }

  // ── 1. Connect to Database ────────────────────────────────────────────────
  console.log('⏳ Connecting to MySQL database on port 3307…');
  await initializeDatabase();
  console.log('');

  // ── 2. Create the target table ────────────────────────────────────────────
  console.log('⏳ Re-creating table `color_combos_with_predictions`…');
  await pool.query('DROP TABLE IF EXISTS `color_combos_with_predictions`');
  await pool.query(`
    CREATE TABLE \`color_combos_with_predictions\` (
      \`id\` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`top_color\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`top_outer_color\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '-',
      \`bottom_color\` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`outerwear_color\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`footwear_color\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`predicted_top_outer_color\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '-',
      \`prediction_score\` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '-',
      \`prediction_confidence\` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '-',
      \`prediction_reasons\` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      \`created_at\` timestamp NULL DEFAULT NULL,
      \`updated_at\` timestamp NULL DEFAULT NULL,
      \`is_active\` tinyint(1) DEFAULT NULL,
      PRIMARY KEY (\`top_color\`,\`bottom_color\`,\`outerwear_color\`,\`footwear_color\`,\`top_outer_color\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ Table `color_combos_with_predictions` created successfully.');
  console.log('');

  // ── 3. Read the CSV file ──────────────────────────────────────────────────
  console.log('⏳ Reading CSV predicted rows…');
  const allLines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(INPUT), crlfDelay: Infinity });
    rl.on('line', line => allLines.push(line));
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  const totalRows = allLines.length - 1; // subtract header
  console.log(`   Found ${totalRows.toLocaleString()} predictions to upload.\n`);

  // ── 4. Batch Ingestion ────────────────────────────────────────────────────
  console.log('⏳ Uploading rows to MySQL in high-performance batches…');
  const BATCH_SIZE = 1000;
  let batchValues: any[] = [];
  let processedCount = 0;

  const insertSql = `
    INSERT IGNORE INTO \`color_combos_with_predictions\` (
      id, top_color, top_outer_color, bottom_color, outerwear_color, footwear_color,
      predicted_top_outer_color, prediction_score, prediction_confidence, prediction_reasons,
      created_at, updated_at, is_active
    ) VALUES ?
  `;

  for (let i = 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.trim()) continue;

    // Parse CSV safely (taking care of double quotes in reasons list)
    // Format: id,top_color,top_outer_color,bottom_color,outerwear_color,footwear_color,created_at,updated_at,is_active,predicted_top_outer,score,confidence,reasons
    const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
    const id = parts[0]?.trim() || '';
    const topColor = parts[1]?.trim() || '';
    const topOuterColor = parts[2]?.trim() || '-';
    const bottomColor = parts[3]?.trim() || '';
    const outerwearColor = parts[4]?.trim() || '';
    const footwearColor = parts[5]?.trim() || '';
    
    // Pred columns
    const predictedTopOuter = parts[9]?.trim() || '-';
    const score = parts[10]?.trim() || '-';
    const confidence = parts[11]?.trim() || '-';
    let reasons = parts[12]?.trim() || '';
    reasons = reasons.replace(/^"|"$/g, ''); // remove wrapping quotes

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    batchValues.push([
      id, topColor, topOuterColor, bottomColor, outerwearColor, footwearColor,
      predictedTopOuter, score, confidence, reasons,
      now, now, 1
    ]);

    processedCount++;

    if (batchValues.length >= BATCH_SIZE || i === allLines.length - 1) {
      await pool.query(insertSql, [batchValues]);
      batchValues = [];
      process.stdout.write(`\r   ${progress(processedCount, totalRows)}`);
    }
  }

  process.stdout.write(`\r   ${progress(totalRows, totalRows)}\n\n`);
  console.log(`✅ Upload complete! Successfully inserted ${processedCount.toLocaleString()} rows.`);

  // ── 5. Clean up ───────────────────────────────────────────────────────────
  await closeDatabase();
  console.log('✅ Database connection cleanly closed.');
}

main().catch(err => {
  console.error('\n❌ Ingestion failed:', err);
  process.exit(1);
});
