// src/db/mysqlAdapter.ts
// ============================================================================
// MYSQL ADAPTER — InteractionStore implementation using mysql2/promise
// ============================================================================
//
// Uses the existing mysql2 connection pool from src/config/database.ts.
// This adapter creates a `user_interactions` table in your existing MySQL DB.
//
// To swap this out for your company's database:
//   1. Copy this file as a template
//   2. Change the SQL queries to match your schema
//   3. Register in src/db/index.ts
// ============================================================================

import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';
import {
  InteractionStore,
  InteractionRecord,
  InteractionFilters,
  InteractionStats,
  UserProfile,
  RollupResult,
} from './types';

/** Columns written to archive CSV files (metadata JSON is intentionally
 *  excluded so rows stay comma-safe for simple parsing). */
const ARCHIVE_HEADER =
  'id,user_id,action,top_color,bottom_color,outerwear_color,footwear_color,' +
  'top_outer_color,interaction_score,confidence_score,model_version,vibe,occasion,fit_type,created_at';

/** In-memory aggregate for one (user, month) group during rollup. */
interface MonthAggregate {
  totalSaves: number;
  totalFlags: number;
  colorCounts: Record<string, number>;
  slotCounts: Record<string, Record<string, number>>;
  contextCounts: Record<string, Record<string, number>>;
}

function emptyAggregate(): MonthAggregate {
  return {
    totalSaves: 0,
    totalFlags: 0,
    colorCounts: {},
    slotCounts: { top: {}, bottom: {}, outerwear: {}, footwear: {} },
    contextCounts: { vibe: {}, occasion: {}, fitType: {} },
  };
}

function bump(map: Record<string, number>, key: string | null | undefined): void {
  if (!key) return;
  const k = String(key).trim().toLowerCase();
  if (!k || k === '-') return;
  map[k] = (map[k] || 0) + 1;
}

/** Accumulate one raw interaction row into an aggregate. */
function accumulateRow(agg: MonthAggregate, row: any): void {
  if (row.action === 'save') {
    agg.totalSaves += 1;
    // Only saves express positive color preference
    bump(agg.colorCounts, row.top_outer_color);
    bump(agg.slotCounts.top, row.top_color);
    bump(agg.slotCounts.bottom, row.bottom_color);
    bump(agg.slotCounts.outerwear, row.outerwear_color);
    bump(agg.slotCounts.footwear, row.footwear_color);
    bump(agg.contextCounts.vibe, row.vibe);
    bump(agg.contextCounts.occasion, row.occasion);
    bump(agg.contextCounts.fitType, row.fit_type);
  } else {
    agg.totalFlags += 1;
  }
}

/** Additively merge aggregate `b` into `a` (used when a summary month already exists). */
function mergeAggregates(a: MonthAggregate, b: MonthAggregate): MonthAggregate {
  const mergeCounts = (x: Record<string, number>, y: Record<string, number>) => {
    for (const [k, v] of Object.entries(y)) x[k] = (x[k] || 0) + v;
  };
  a.totalSaves += b.totalSaves;
  a.totalFlags += b.totalFlags;
  mergeCounts(a.colorCounts, b.colorCounts);
  for (const slot of Object.keys(b.slotCounts)) {
    a.slotCounts[slot] = a.slotCounts[slot] || {};
    mergeCounts(a.slotCounts[slot], b.slotCounts[slot]);
  }
  for (const ctx of Object.keys(b.contextCounts)) {
    a.contextCounts[ctx] = a.contextCounts[ctx] || {};
    mergeCounts(a.contextCounts[ctx], b.contextCounts[ctx]);
  }
  return a;
}

function monthKeyOf(createdAt: any): string {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class MySQLAdapter implements InteractionStore {

  // ══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ══════════════════════════════════════════════════════════════════════════

  async initialize(): Promise<void> {
    if (!pool) {
      throw new Error('[InteractionStore] MySQL pool not available. Ensure initializeDatabase() was called first.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_interactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        action ENUM('save', 'flag') NOT NULL DEFAULT 'save',
        
        top_color VARCHAR(100) NOT NULL,
        bottom_color VARCHAR(100) NOT NULL,
        outerwear_color VARCHAR(100) NOT NULL,
        footwear_color VARCHAR(100) NOT NULL,
        top_outer_color VARCHAR(100) NOT NULL,
        
        interaction_score INT NOT NULL DEFAULT 2,
        confidence_score FLOAT DEFAULT NULL,
        model_version VARCHAR(50) DEFAULT NULL,
        
        vibe VARCHAR(100) DEFAULT NULL,
        occasion VARCHAR(100) DEFAULT NULL,
        fit_type VARCHAR(100) DEFAULT NULL,
        
        metadata JSON DEFAULT NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        INDEX idx_user_id (user_id),
        INDEX idx_action (action),
        INDEX idx_created_at (created_at),
        INDEX idx_user_action (user_id, action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profile_summaries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        period_month CHAR(7) NOT NULL,
        total_saves INT NOT NULL DEFAULT 0,
        total_flags INT NOT NULL DEFAULT 0,
        color_counts JSON NOT NULL,
        slot_counts JSON NOT NULL,
        context_counts JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_month (user_id, period_month),
        INDEX idx_summary_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[InteractionStore] ✅ user_interactions + user_profile_summaries tables verified in MySQL.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SAVE
  // ══════════════════════════════════════════════════════════════════════════

  async saveInteraction(record: Omit<InteractionRecord, 'id' | 'createdAt'>): Promise<InteractionRecord> {
    const [result]: any = await pool.query(
      `INSERT INTO user_interactions 
       (user_id, action, top_color, bottom_color, outerwear_color, footwear_color, top_outer_color,
        interaction_score, confidence_score, model_version, vibe, occasion, fit_type, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.userId,
        record.action,
        record.topColor,
        record.bottomColor,
        record.outerwearColor,
        record.footwearColor,
        record.topOuterColor,
        record.interactionScore,
        record.confidenceScore ?? null,
        record.modelVersion ?? null,
        record.vibe ?? null,
        record.occasion ?? null,
        record.fitType ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      ]
    );

    return {
      ...record,
      id: result.insertId,
      createdAt: new Date().toISOString(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUERY
  // ══════════════════════════════════════════════════════════════════════════

  async getInteractions(filters?: InteractionFilters): Promise<InteractionRecord[]> {
    let sql = 'SELECT * FROM user_interactions WHERE 1=1';
    const params: any[] = [];

    if (filters?.userId) {
      sql += ' AND user_id = ?';
      params.push(filters.userId);
    }
    if (filters?.action) {
      sql += ' AND action = ?';
      params.push(filters.action);
    }
    if (filters?.startDate) {
      sql += ' AND created_at >= ?';
      params.push(filters.startDate);
    }
    if (filters?.endDate) {
      sql += ' AND created_at <= ?';
      params.push(filters.endDate);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters?.offset) {
      sql += ' OFFSET ?';
      params.push(filters.offset);
    }

    const [rows]: any = await pool.query(sql, params);
    return rows.map(this.rowToRecord);
  }

  async getInteractionsByUser(userId: string, limit: number = 100): Promise<InteractionRecord[]> {
    const [rows]: any = await pool.query(
      'SELECT * FROM user_interactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    return rows.map(this.rowToRecord);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATS
  // ══════════════════════════════════════════════════════════════════════════

  async getStats(): Promise<InteractionStats> {
    const [totalRows]: any = await pool.query('SELECT COUNT(*) as count FROM user_interactions');
    const [saveRows]: any = await pool.query("SELECT COUNT(*) as count FROM user_interactions WHERE action = 'save'");
    const [flagRows]: any = await pool.query("SELECT COUNT(*) as count FROM user_interactions WHERE action = 'flag'");
    const [userRows]: any = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM user_interactions');
    const [dateRows]: any = await pool.query('SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM user_interactions');

    return {
      totalInteractions: totalRows[0].count,
      totalSaves: saveRows[0].count,
      totalFlags: flagRows[0].count,
      uniqueUsers: userRows[0].count,
      oldestRecord: dateRows[0].oldest?.toISOString?.() ?? undefined,
      newestRecord: dateRows[0].newest?.toISOString?.() ?? undefined,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXPORT FOR ML TRAINING
  // ══════════════════════════════════════════════════════════════════════════

  async exportForTraining(outputPath?: string): Promise<string> {
    const exportPath = outputPath || path.join(process.cwd(), 'data', 'training_export.csv');
    
    const [rows]: any = await pool.query(
      `SELECT id as session_id, top_color, bottom_color, outerwear_color, 
              footwear_color, top_outer_color as predicted_color, interaction_score
       FROM user_interactions
       ORDER BY id ASC`
    );

    // Write CSV header + rows in the exact format train.py expects
    const header = 'session_id,top_color,bottom_color,outerwear_color,footwear_color,predicted_color,interaction_score\n';
    const liveRows: string[] = rows.map((r: any) =>
      `${r.session_id},${r.top_color},${r.bottom_color},${r.outerwear_color},${r.footwear_color},${r.predicted_color},${r.interaction_score}`
    );

    // Merge archived (pruned) interactions back in so retraining always sees
    // the FULL history, not just the hot table's last retention window.
    const archivedRows = this.readArchivedTrainingRows();

    // Ensure directory exists
    const dir = path.dirname(exportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const allRows = [...archivedRows, ...liveRows];
    fs.writeFileSync(exportPath, header + allRows.join('\n') + '\n', 'utf8');
    console.log(`[InteractionStore] ✅ Exported ${allRows.length} records (${liveRows.length} live + ${archivedRows.length} archived) to ${exportPath}`);
    
    return exportPath;
  }

  /**
   * Reads all archive CSV files and maps them to training-export rows.
   * Archive rows keep their original interaction id as session_id, so ids
   * never collide with live rows (they were deleted from the hot table).
   */
  private readArchivedTrainingRows(): string[] {
    const archiveDir = path.join(process.cwd(), 'data', 'archive');
    if (!fs.existsSync(archiveDir)) return [];

    const out: string[] = [];
    const files = fs.readdirSync(archiveDir).filter(f => f.startsWith('interactions_') && f.endsWith('.csv')).sort();

    for (const file of files) {
      const lines = fs.readFileSync(path.join(archiveDir, file), 'utf8').trim().split('\n');
      for (let i = 1; i < lines.length; i++) {           // skip header
        const parts = lines[i].split(',');
        if (parts.length < 15) continue;
        const [id, , , topColor, bottomColor, outerwearColor, footwearColor, topOuterColor, score] = parts;
        out.push(`${id},${topColor},${bottomColor},${outerwearColor},${footwearColor},${topOuterColor},${score}`);
      }
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE ROLLUP — summarize, archive, prune old interactions
  // ══════════════════════════════════════════════════════════════════════════

  async rollupOldInteractions(cutoffIso: string, archiveDir: string): Promise<RollupResult> {
    const result: RollupResult = {
      cutoffDate: cutoffIso,
      rowsExamined: 0,
      rowsArchived: 0,
      rowsDeleted: 0,
      summariesUpserted: 0,
      archiveFiles: [],
    };

    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    const BATCH_SIZE = 2000;
    const touchedFiles = new Set<string>();

    // Process in bounded batches so a huge backlog never holds one giant
    // transaction or loads millions of rows into memory.
    for (;;) {
      const [rows]: any = await pool.query(
        'SELECT * FROM user_interactions WHERE created_at < ? ORDER BY id ASC LIMIT ?',
        [cutoffIso, BATCH_SIZE]
      );
      if (rows.length === 0) break;
      result.rowsExamined += rows.length;

      // 1. Archive first (durable on disk before anything is deleted).
      //    If we crash after this step, the worst case is duplicate archive
      //    lines on the next run — never data loss.
      const byMonth = new Map<string, any[]>();
      for (const row of rows) {
        const month = monthKeyOf(row.created_at);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month)!.push(row);
      }

      for (const [month, monthRows] of byMonth) {
        const filePath = path.join(archiveDir, `interactions_${month}.csv`);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, ARCHIVE_HEADER + '\n', 'utf8');
        }
        const csvLines = monthRows.map((r: any) => [
          r.id, r.user_id, r.action,
          r.top_color, r.bottom_color, r.outerwear_color, r.footwear_color, r.top_outer_color,
          r.interaction_score, r.confidence_score ?? '', r.model_version ?? '',
          r.vibe ?? '', r.occasion ?? '', r.fit_type ?? '',
          (r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at),
        ].join(','));
        fs.appendFileSync(filePath, csvLines.join('\n') + '\n', 'utf8');
        touchedFiles.add(filePath);
      }
      result.rowsArchived += rows.length;

      // 2. Aggregate per (user, month) in memory.
      const groups = new Map<string, MonthAggregate>();
      for (const row of rows) {
        const key = `${row.user_id}\u0000${monthKeyOf(row.created_at)}`;
        if (!groups.has(key)) groups.set(key, emptyAggregate());
        accumulateRow(groups.get(key)!, row);
      }

      // 3. Merge summaries + delete rows atomically. Both tables live in the
      //    same MySQL database, so one transaction guarantees we never delete
      //    rows whose counts failed to land in a summary.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        for (const [key, agg] of groups) {
          const [userId, month] = key.split('\u0000');
          const [existing]: any = await conn.query(
            'SELECT * FROM user_profile_summaries WHERE user_id = ? AND period_month = ? FOR UPDATE',
            [userId, month]
          );

          let merged = agg;
          if (existing.length > 0) {
            const prev = existing[0];
            const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
            merged = mergeAggregates({
              totalSaves: prev.total_saves,
              totalFlags: prev.total_flags,
              colorCounts: parse(prev.color_counts),
              slotCounts: parse(prev.slot_counts),
              contextCounts: parse(prev.context_counts),
            }, agg);
          }

          await conn.query(
            `INSERT INTO user_profile_summaries
               (user_id, period_month, total_saves, total_flags, color_counts, slot_counts, context_counts)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               total_saves = VALUES(total_saves),
               total_flags = VALUES(total_flags),
               color_counts = VALUES(color_counts),
               slot_counts = VALUES(slot_counts),
               context_counts = VALUES(context_counts)`,
            [
              userId, month, merged.totalSaves, merged.totalFlags,
              JSON.stringify(merged.colorCounts),
              JSON.stringify(merged.slotCounts),
              JSON.stringify(merged.contextCounts),
            ]
          );
          result.summariesUpserted++;
        }

        const ids = rows.map((r: any) => r.id);
        const [del]: any = await conn.query('DELETE FROM user_interactions WHERE id IN (?)', [ids]);
        result.rowsDeleted += del.affectedRows;

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    result.archiveFiles = [...touchedFiles];
    if (result.rowsExamined > 0) {
      console.log(
        `[InteractionStore] 📦 Rollup complete: ${result.rowsDeleted} rows pruned, ` +
        `${result.summariesUpserted} summaries updated, archives: ${result.archiveFiles.map(f => path.basename(f)).join(', ')}`
      );
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USER PROFILE — merged summaries + live rows
  // ══════════════════════════════════════════════════════════════════════════

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    // 1. All historical summary months
    const [summaryRows]: any = await pool.query(
      'SELECT * FROM user_profile_summaries WHERE user_id = ? ORDER BY period_month ASC',
      [userId]
    );

    // 2. Live (not-yet-rolled-up) interactions, aggregated on the fly so the
    //    profile always reflects the user's most recent behavior too.
    const [liveRows]: any = await pool.query(
      'SELECT * FROM user_interactions WHERE user_id = ?',
      [userId]
    );

    if (summaryRows.length === 0 && liveRows.length === 0) return null;

    const total = emptyAggregate();
    const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

    for (const s of summaryRows) {
      mergeAggregates(total, {
        totalSaves: s.total_saves,
        totalFlags: s.total_flags,
        colorCounts: parse(s.color_counts),
        slotCounts: parse(s.slot_counts),
        contextCounts: parse(s.context_counts),
      });
    }
    for (const row of liveRows) {
      accumulateRow(total, row);
    }

    // Normalize color counts into 0..1 affinities (share of user's saves)
    const totalColorCount = Object.values(total.colorCounts).reduce((a, b) => a + b, 0);
    const colorAffinity: Record<string, number> = {};
    if (totalColorCount > 0) {
      for (const [color, count] of Object.entries(total.colorCounts)) {
        colorAffinity[color] = Number((count / totalColorCount).toFixed(4));
      }
    }

    const favoriteColors = Object.entries(total.colorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([color]) => color);

    const topOf = (counts: Record<string, number>): string | null => {
      const entries = Object.entries(counts);
      if (entries.length === 0) return null;
      return entries.sort((a, b) => b[1] - a[1])[0][0];
    };

    return {
      userId,
      monthsSummarized: summaryRows.length,
      totalSaves: total.totalSaves,
      totalFlags: total.totalFlags,
      colorAffinity,
      favoriteColors,
      contextPreferences: {
        vibe: topOf(total.contextCounts.vibe || {}),
        occasion: topOf(total.contextCounts.occasion || {}),
        fitType: topOf(total.contextCounts.fitType || {}),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE (GDPR)
  // ══════════════════════════════════════════════════════════════════════════

  async deleteUserInteractions(userId: string): Promise<number> {
    const [result]: any = await pool.query(
      'DELETE FROM user_interactions WHERE user_id = ?',
      [userId]
    );
    console.log(`[InteractionStore] 🗑️ Deleted ${result.affectedRows} records for user: ${userId}`);
    return result.affectedRows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MIGRATION — Import existing CSV data
  // ══════════════════════════════════════════════════════════════════════════

  async importFromCSV(csvPath: string): Promise<number> {
    if (!fs.existsSync(csvPath)) {
      console.warn(`[InteractionStore] CSV file not found at ${csvPath}, skipping import.`);
      return 0;
    }

    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.trim().split('\n');
    
    // Detect if first line is a header
    const firstLine = lines[0];
    const startIdx = firstLine.includes('session_id') || firstLine.includes('top_color') ? 1 : 0;
    
    let imported = 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 7) continue;

      const [_sessionId, topColor, bottomColor, outerwearColor, footwearColor, predictedColor, scoreStr] = parts;
      const score = parseInt(scoreStr, 10);

      try {
        await pool.query(
          `INSERT INTO user_interactions 
           (user_id, action, top_color, bottom_color, outerwear_color, footwear_color, top_outer_color, interaction_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'legacy_import',                                    // Default user for imported data
            score > 0 ? 'save' : 'flag',                       // Infer action from score
            topColor.trim().toLowerCase(),
            bottomColor.trim().toLowerCase(),
            outerwearColor.trim().toLowerCase(),
            footwearColor.trim().toLowerCase(),
            predictedColor.trim().toLowerCase(),
            isNaN(score) ? 2 : score,
          ]
        );
        imported++;
      } catch (err) {
        // Skip duplicate or malformed rows silently
        console.warn(`[InteractionStore] Skipped row ${i}: ${err}`);
      }
    }

    console.log(`[InteractionStore] ✅ Imported ${imported} of ${lines.length - startIdx} records from CSV.`);
    return imported;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════════════════

  async close(): Promise<void> {
    // Pool is managed by src/config/database.ts, nothing extra to do here
    console.log('[InteractionStore] Adapter closed.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private rowToRecord(row: any): InteractionRecord {
    return {
      id: row.id,
      userId: row.user_id,
      action: row.action,
      topColor: row.top_color,
      bottomColor: row.bottom_color,
      outerwearColor: row.outerwear_color,
      footwearColor: row.footwear_color,
      topOuterColor: row.top_outer_color,
      interactionScore: row.interaction_score,
      confidenceScore: row.confidence_score ?? undefined,
      modelVersion: row.model_version ?? undefined,
      vibe: row.vibe ?? undefined,
      occasion: row.occasion ?? undefined,
      fitType: row.fit_type ?? undefined,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
    };
  }
}
