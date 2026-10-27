import { readFileSync } from 'node:fs';

import mysql from 'mysql2/promise';

import { config } from '../config.js';

const { ssl, sslCa, ...db } = config.db;

/**
 * One pool for the process. Dates come back as JS Dates in UTC.
 *
 * Every connection's session time zone is set to UTC (C-12), so column
 * defaults (CURRENT_TIMESTAMP) and UTC_TIMESTAMP() agree whatever zone the
 * server itself runs in. The code writes times with UTC_TIMESTAMP(3) only.
 */
export const pool = mysql.createPool({
  ...db,
  ...(ssl && { ssl: { rejectUnauthorized: true, ...(sslCa && { ca: readFileSync(sslCa, 'utf8') }) } }),
  connectionLimit: 10,
  timezone: 'Z',
  dateStrings: false,
  charset: 'utf8mb4_0900_ai_ci',
  // JSON columns come back parsed.
  typeCast(field, next) {
    if (field.type === 'JSON') {
      const text = field.string('utf8');
      return text === null ? null : JSON.parse(text);
    }
    return next();
  },
});

// `connection` hands over the callback-style connection underneath.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Runs [fn] with one connection inside a transaction. */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** First row of a query, or null. */
export async function one(db, sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0] ?? null;
}

export async function many(db, sql, params) {
  const [rows] = await db.query(sql, params);
  return rows;
}
