import fs from 'fs';
import path from 'path';
import { pool } from './config/database';

export interface FlaggedCombination {
  id: string;
  topColor?: string;
  bottomColor?: string;
  outerwearColor?: string;
  footwearColor?: string;
  topOuterColor?: string;
  reason?: string;
  flaggedAt?: string;
}

export class FlaggingSystem {
  private flaggedList: FlaggedCombination[] = [];
  private filePath = path.join(process.cwd(), 'data', 'flagged_outfits.json');

  constructor() {
    this.loadFlags();
  }

  private loadFlags() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.flaggedList = JSON.parse(raw);
        console.log(`[Flag System] Loaded ${this.flaggedList.length} flagged outfits from JSON`);
      } else {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify([], null, 2));
      }
    } catch (err) {
      console.error('[Flag System] Failed to load flagged outfits from JSON:', err);
    }
  }

  private saveFlags() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.flaggedList, null, 2));
    } catch (err) {
      console.error('[Flag System] Failed to save flagged outfits to JSON:', err);
    }
  }

  async syncDatabaseTable() {
    try {
      if (!pool) return;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS flagged_combinations (
          id VARCHAR(50) PRIMARY KEY,
          top_color VARCHAR(100),
          bottom_color VARCHAR(100),
          outerwear_color VARCHAR(100),
          footwear_color VARCHAR(100),
          top_outer_color VARCHAR(100),
          reason TEXT,
          flagged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[Flag System] Database flagged_combinations table verified.');
    } catch (err) {
      console.warn('[Flag System] Database table creation/check failed (running in offline/fallback mode):', err);
    }
  }

  async addFlag(flag: Omit<FlaggedCombination, 'id' | 'flaggedAt'>): Promise<FlaggedCombination> {
    const newFlag: FlaggedCombination = {
      id: Math.random().toString(36).substr(2, 9),
      topColor: flag.topColor || undefined,
      bottomColor: flag.bottomColor || undefined,
      outerwearColor: flag.outerwearColor || undefined,
      footwearColor: flag.footwearColor || undefined,
      topOuterColor: flag.topOuterColor || undefined,
      reason: flag.reason || 'Flagged by style team',
      flaggedAt: new Date().toISOString()
    };

    // Prevent duplicates
    const isDup = this.flaggedList.some(f => 
      f.topColor === newFlag.topColor &&
      f.bottomColor === newFlag.bottomColor &&
      f.outerwearColor === newFlag.outerwearColor &&
      f.footwearColor === newFlag.footwearColor &&
      f.topOuterColor === newFlag.topOuterColor
    );

    if (!isDup) {
      this.flaggedList.push(newFlag);
      this.saveFlags();

      try {
        if (pool) {
          await pool.query(
            `INSERT INTO flagged_combinations (id, top_color, bottom_color, outerwear_color, footwear_color, top_outer_color, reason) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              newFlag.id,
              newFlag.topColor || null,
              newFlag.bottomColor || null,
              newFlag.outerwearColor || null,
              newFlag.footwearColor || null,
              newFlag.topOuterColor || null,
              newFlag.reason
            ]
          );
        }
      } catch (err) {
        console.warn('[Flag System] Failed to insert flag into MySQL, saved to local JSON instead:', err);
      }
    }

    return newFlag;
  }

  async getFlags(): Promise<FlaggedCombination[]> {
    return this.flaggedList;
  }

  /**
   * Checks if a set of colors matches any flagged rules.
   * Returns the matching flag if it does, otherwise null.
   */
  isFlagged(outfit: {
    topColor?: string;
    bottomColor?: string;
    outerwearColor?: string;
    footwearColor?: string;
    topOuterColor?: string;
  }): FlaggedCombination | null {
    for (const rule of this.flaggedList) {
      let matches = true;

      if (rule.topColor && (!outfit.topColor || rule.topColor.toLowerCase() !== outfit.topColor.toLowerCase())) {
        matches = false;
      }
      if (rule.bottomColor && (!outfit.bottomColor || rule.bottomColor.toLowerCase() !== outfit.bottomColor.toLowerCase())) {
        matches = false;
      }
      if (rule.outerwearColor && (!outfit.outerwearColor || rule.outerwearColor.toLowerCase() !== outfit.outerwearColor.toLowerCase())) {
        matches = false;
      }
      if (rule.footwearColor && (!outfit.footwearColor || rule.footwearColor.toLowerCase() !== outfit.footwearColor.toLowerCase())) {
        matches = false;
      }
      if (rule.topOuterColor && (!outfit.topOuterColor || rule.topOuterColor.toLowerCase() !== outfit.topOuterColor.toLowerCase())) {
        matches = false;
      }

      const ruleHasFilters = !!(rule.topColor || rule.bottomColor || rule.outerwearColor || rule.footwearColor || rule.topOuterColor);

      if (matches && ruleHasFilters) {
        return rule;
      }
    }
    return null;
  }
}

export const flagger = new FlaggingSystem();
