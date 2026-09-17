#!/usr/bin/env ts-node
/**
 * ============================================================================
 * BATCH PREDICTION & DATABASE SYNCHRONIZATION SCRIPT
 * ============================================================================
 *
 * Reads colorcombos.csv, predicts top_outer_color for every row where the
 * field is '-', then writes colorcombos_with_predictions.csv.
 *
 * Additionally, if the MySQL database container is active (port 3307), it
 * automatically synchronizes the new CSV color combinations into the
 * database color_combos table, ensuring consistency.
 *
 * Usage:
 *   npx ts-node scripts/generate_predictions.ts
 *
 * Output:
 *   colorcombos_with_predictions.csv   (new file, safe)
 *   prediction_summary.json            (stats)
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import 'dotenv/config';
import { SequentialFilterEngine } from '../src/sequentialFilter';
import { pool, initializeDatabase, closeDatabase } from '../src/config/database';

const ROOT     = path.join(__dirname, '..');
const INPUT    = path.join(ROOT, 'data', 'colorcombos.csv');
const OUTPUT   = path.join(ROOT, 'data', 'colorcombos_with_predictions.csv');
const SUMMARY  = path.join(ROOT, 'data', 'prediction_summary.json');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function progress(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  return `[${bar}] ${pct}% (${current}/${total})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   twelve70 — Batch Prediction & Sync      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── Step 1: Initialise the engine ─────────────────────────────────────────
  console.log('⏳ Loading CSV data into engine…');
  const eng = new SequentialFilterEngine();
  await eng.initialize(ROOT);
  console.log('');

  // ── Step 2: Try to connect to MySQL database ──────────────────────────────
  let dbActive = false;
  try {
    console.log('⏳ Attempting to connect to MySQL database on port 3307…');
    await initializeDatabase();
    dbActive = true;
    console.log('✅ Connected to database successfully.');
  } catch (err) {
    console.warn('⚠️  Could not connect to database. Skipping SQL synchronization.');
  }
  console.log('');

  // ── Step 3: Synchronise combinations if DB is active ──────────────────────
  if (dbActive) {
    try {
      console.log('⏳ Synchronizing CSV combinations to MySQL table `color_combos`…');
      const [existingRows]: any = await pool.query(
        'SELECT id, top_color, bottom_color, outerwear_color, footwear_color, top_outer_color FROM color_combos'
      );
      
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        const key = `${row.top_color}_${row.bottom_color}_${row.outerwear_color}_${row.footwear_color}_${row.top_outer_color}`.toLowerCase();
        existingKeys.add(key);
        if (row.id) {
          existingKeys.add(row.id.toLowerCase());
        }
      }

      let insertedCount = 0;
      for (const r of eng.getAllRows()) {
        const key = `${r.topColor}_${r.bottomColor}_${r.outerwearColor}_${r.footwearColor}_${r.topOuterColor}`.toLowerCase();
        if (!existingKeys.has(key)) {
          const newId = require('crypto').randomUUID();
          await pool.query(
            `INSERT INTO color_combos (id, top_color, bottom_color, outerwear_color, footwear_color, top_outer_color, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
            [newId, r.topColor, r.bottomColor, r.outerwearColor, r.footwearColor, r.topOuterColor]
          );
          insertedCount++;
          existingKeys.add(key);
        }
      }
      console.log(`✅ Database synchronized: Added ${insertedCount} new color combinations.`);
    } catch (dbSyncErr) {
      console.error('❌ Failed to synchronize combinations to database:', dbSyncErr);
    }
    console.log('');
  }

  // ── Step 4: Read original CSV line by line ────────────────────────────────
  console.log('⏳ Scanning original CSV…');
  const allLines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(INPUT), crlfDelay: Infinity });
    rl.on('line', line => allLines.push(line));
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  const totalRows = allLines.length - 1; // subtract header
  console.log(`   Found ${totalRows.toLocaleString()} data rows\n`);

  // ── Step 5: Process rows & run predictions ────────────────────────────────
  const header = allLines[0] +
    ',predicted_top_outer_color,prediction_score,prediction_confidence,prediction_reasons';

  const outputLines: string[] = [header];

  let predicted  = 0;
  let skipped    = 0;
  let totalScore = 0;

  const matchTypeCounts: Record<string, number> = {
    exact: 0, partial: 0, scored: 0, fallback: 0
  };

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  for (let i = 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.trim()) { outputLines.push(line); continue; }

    // CSV cols: id,top_color,top_outer_color,bottom_color,outerwear_color,footwear_color,...
    const parts = line.split(',');
    const topOuterColor = parts[2]?.trim();

    if (topOuterColor && topOuterColor !== '-' && topOuterColor !== '') {
      // Already has a value — keep it, add empty prediction columns
      outputLines.push(line + ',-,-,-,-');
      skipped++;
    } else {
      // Predict
      const topColor      = parts[1]?.trim() || '';
      const bottomColor   = parts[3]?.trim() || '';
      const outerwearColor = parts[4]?.trim() || '';
      const footwearColor = parts[5]?.trim() || '';

      const result = eng.predictTopOuter(topColor, bottomColor, outerwearColor, footwearColor);

      matchTypeCounts[result.matchType]++;
      totalScore += result.primary.score;
      predicted++;

      const confidence = result.matchType === 'exact'   ? 'high'
                       : result.matchType === 'partial' ? 'medium'
                       : result.matchType === 'scored'  ? 'low'
                       : 'fallback';

      const reasons = result.primary.reasons.slice(0, 2).join(' | ').replace(/,/g, ';');

      outputLines.push(
        `${line},${result.primary.color},${result.primary.score},${confidence},"${reasons}"`
      );
    }

    // Print progress every 2500 rows
    if (i % 2500 === 0) {
      process.stdout.write(`\r   ${progress(i, totalRows)}`);
    }
  }

  process.stdout.write(`\r   ${progress(totalRows, totalRows)}\n\n`);

  // ── Step 6: Write output CSV ──────────────────────────────────────────────
  fs.writeFileSync(OUTPUT, outputLines.join('\n'), 'utf-8');
  console.log(`✅ Written: ${path.basename(OUTPUT)}`);
  console.log(`   Size: ${(fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2)} MB\n`);

  // ── Step 7: Write summary JSON ────────────────────────────────────────────
  const avgScore = predicted > 0 ? Math.round(totalScore / predicted) : 0;
  const summary = {
    generatedAt:     now,
    inputFile:       path.basename(INPUT),
    outputFile:      path.basename(OUTPUT),
    totalRows,
    rowsPredicted:   predicted,
    rowsSkipped:     skipped,
    averageScore:    avgScore,
    matchTypeBreakdown: matchTypeCounts,
    notes: [
      'Predictions only filled where top_outer_color was "-" or empty.',
      'Original file was not modified.',
      'Score range: 0 (poor) → 100 (perfect match).',
      'Confidence: high=exact DB match | medium=partial | low=family-scored | fallback=default.',
    ],
  };

  fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`✅ Written: ${path.basename(SUMMARY)}\n`);

  // ── Step 8: Close database ────────────────────────────────────────────────
  if (dbActive) {
    await closeDatabase();
  }

  // ── Step 9: Print summary ─────────────────────────────────────────────────
  console.log('┌─────────────────────────────────┐');
  console.log('│          SUMMARY                │');
  console.log('├─────────────────────────────────┤');
  console.log(`│  Total rows     : ${String(totalRows).padEnd(13)}│`);
  console.log(`│  Predicted      : ${String(predicted).padEnd(13)}│`);
  console.log(`│  Already set    : ${String(skipped).padEnd(13)}│`);
  console.log(`│  Avg score      : ${String(avgScore + '/100').padEnd(13)}│`);
  console.log('├─────────────────────────────────┤');
  console.log(`│  Exact matches  : ${String(matchTypeCounts.exact).padEnd(13)}│`);
  console.log(`│  Partial matches: ${String(matchTypeCounts.partial).padEnd(13)}│`);
  console.log(`│  Family-scored  : ${String(matchTypeCounts.scored).padEnd(13)}│`);
  console.log(`│  Fallbacks      : ${String(matchTypeCounts.fallback).padEnd(13)}│`);
  console.log('└─────────────────────────────────┘');
}

main().catch(err => {
  console.error('\n❌ Script failed:', err);
  process.exit(1);
});
