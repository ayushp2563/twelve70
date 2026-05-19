import express, { Request, Response } from 'express';
import { pool } from '../config/database';

/**
 * Database Explorer Routes
 * Provides read-only access to browse all MySQL tables on port 3000.
 * Mounted at /api/db/*
 */
export function setupDbExplorerRoutes(app: express.Application): void {

  // GET /api/db/tables — list all tables with row counts
  app.get('/api/db/tables', async (_req: Request, res: Response) => {
    try {
      const [tables]: any = await pool.query(`
        SELECT 
          TABLE_NAME as name,
          TABLE_ROWS as approxRows,
          ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024, 1) as sizeKB,
          TABLE_COMMENT as comment,
          CREATE_TIME as createdAt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME ASC
      `);
      res.json({ success: true, tables });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/db/tables/:table/schema — columns definition
  app.get('/api/db/tables/:table/schema', async (req: Request, res: Response) => {
    const { table } = req.params;
    try {
      const [columns]: any = await pool.query(`
        SELECT 
          COLUMN_NAME as name,
          COLUMN_TYPE as type,
          IS_NULLABLE as nullable,
          COLUMN_KEY as keyType,
          COLUMN_DEFAULT as defaultVal,
          EXTRA as extra
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [table]);

      const [indexes]: any = await pool.query(`
        SELECT INDEX_NAME as name, COLUMN_NAME as column, NON_UNIQUE as nonUnique
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
      `, [table]);

      res.json({ success: true, columns, indexes });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/db/tables/:table/rows?page=1&limit=50&search=
  app.get('/api/db/tables/:table/rows', async (req: Request, res: Response) => {
    const { table } = req.params;
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const search = (req.query.search as string || '').trim();
    const offset = (page - 1) * limit;

    // Whitelist table name against actual tables to prevent SQL injection
    try {
      const [allowed]: any = await pool.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      if (!allowed.length) return res.status(404).json({ success: false, error: 'Table not found' });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }

    try {
      // Get columns first to build search
      const [cols]: any = await pool.query(
        `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [table]
      );

      let whereClause = '';
      const params: any[] = [];

      if (search) {
        const textCols = cols
          .filter((c: any) => ['varchar','text','char','enum','tinytext','mediumtext','longtext'].includes(c.DATA_TYPE))
          .slice(0, 6); // limit to first 6 text cols for performance
        if (textCols.length) {
          whereClause = 'WHERE ' + textCols.map((c: any) => `\`${c.COLUMN_NAME}\` LIKE ?`).join(' OR ');
          params.push(...textCols.map(() => `%${search}%`));
        }
      }

      const [rows]: any = await pool.query(
        `SELECT * FROM \`${table}\` ${whereClause} LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const [countRes]: any = await pool.query(
        `SELECT COUNT(*) as total FROM \`${table}\` ${whereClause}`,
        params
      );
      const total = countRes[0].total;

      res.json({
        success: true,
        rows,
        columns: cols.map((c: any) => c.COLUMN_NAME),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/db/tables/:table/export?format=csv — download as CSV
  app.get('/api/db/tables/:table/export', async (req: Request, res: Response) => {
    const { table } = req.params;
    try {
      const [allowed]: any = await pool.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      if (!allowed.length) return res.status(404).json({ success: false, error: 'Table not found' });

      const [rows]: any = await pool.query(`SELECT * FROM \`${table}\` LIMIT 5000`);
      if (!rows.length) return res.json({ success: true, data: '' });

      const headers = Object.keys(rows[0]);
      const csv = [
        headers.join(','),
        ...rows.map((r: any) => headers.map(h => {
          const v = r[h] == null ? '' : String(r[h]).replace(/"/g, '""');
          return `"${v}"`;
        }).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
}
