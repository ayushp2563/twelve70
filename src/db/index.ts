// src/db/index.ts
// ============================================================================
// INTERACTION STORE FACTORY
// ============================================================================
//
// This module creates and returns the correct InteractionStore adapter
// based on the DB_ADAPTER environment variable.
//
// ADDING YOUR COMPANY'S DATABASE:
//   1. Create src/db/yourCompanyAdapter.ts implementing InteractionStore
//   2. Add a case below:
//        case 'company':
//          return new YourCompanyAdapter();
//   3. Set DB_ADAPTER=company in .env
//   4. Done! No other files change.
// ============================================================================

import { InteractionStore } from './types';
import { MySQLAdapter } from './mysqlAdapter';

// Singleton instance — created once, reused everywhere
let _store: InteractionStore | null = null;

/**
 * Creates and returns the InteractionStore instance.
 * Uses the DB_ADAPTER env var to select the implementation.
 * 
 * Default: 'mysql' (since the project already uses mysql2)
 * 
 * Future options:
 *   - 'postgres'  → PostgresAdapter
 *   - 'company'   → Your company's custom adapter
 */
export function createInteractionStore(): InteractionStore {
  if (_store) return _store;

  const adapter = process.env.DB_ADAPTER || 'mysql';

  switch (adapter) {
    case 'mysql':
    default:
      _store = new MySQLAdapter();
      break;

    // ── Future adapters ──────────────────────────────────────────
    // case 'postgres':
    //   _store = new PostgresAdapter();
    //   break;
    //
    // case 'company':
    //   _store = new YourCompanyAdapter();
    //   break;
  }

  console.log(`[InteractionStore] Using adapter: ${adapter}`);
  return _store;
}

/**
 * Get the existing store instance (throws if not yet created).
 */
export function getInteractionStore(): InteractionStore {
  if (!_store) {
    throw new Error('[InteractionStore] Store not initialized. Call createInteractionStore() first.');
  }
  return _store;
}

// Re-export types for convenience
export type { InteractionStore, InteractionRecord, InteractionFilters, InteractionStats } from './types';
