// import mysql, { Pool, PoolConnection } from 'mysql2/promise';
 
// let pool: Pool;
 
// export async function initializeDatabase(): Promise<void> {
//   pool = await mysql.createPool({
//     host: process.env.DB_HOST || 'localhost',
//     port: parseInt(process.env.DB_PORT || '3307'),
//     user: process.env.DB_USER || 'myuser',
//     password: process.env.DB_PASSWORD || 'mypass',
//     database: process.env.DB_NAME || 'mydb',
//     waitForConnections: true,
//     connectionLimit: 10,
//     queueLimit: 0,
//     enableKeepAlive: true,
//     keepAliveInitialDelay: 0,
//   });
 
//   console.log('✅ Database pool initialized');
// }
 
// export async function getConnection(): Promise<PoolConnection> {
//   if (!pool) {
//     throw new Error('Database not initialized. Call initializeDatabase() first.');
//   }
//   return pool.getConnection();
// }
 
// export async function closeDatabase(): Promise<void> {
//   if (pool) {
//     await pool.end();
//     console.log('✅ Database pool closed');
//   }
// }

import mysql, { Pool } from 'mysql2/promise';

let pool: Pool;

/**
 * Initialize database pool
 */
export async function initializeDatabase(): Promise<void> {

  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER || 'myuser',
    password: process.env.DB_PASSWORD || 'mypass',
    database: process.env.DB_NAME || 'mydb',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  // Test connection
  const connection = await pool.getConnection();

  console.log('✅ Database pool initialized');

  connection.release();
}

/**
 * Get pool instance
 */
export { pool };

/**
 * Close database pool
 */
export async function closeDatabase(): Promise<void> {

  if (pool) {
    await pool.end();
    console.log('✅ Database connection closed');
  }
}