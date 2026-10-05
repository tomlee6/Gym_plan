import mysql from 'mysql2/promise';

import { config } from '../config.js';

/** One pool for the process. Dates come back as JS Dates in UTC. */
export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 10,
  timezone: 'Z',
  dateStrings: false,
  // JSON columns come back parsed.
  typeCast(field, next) {
    if (field.type === 'JSON') {
      const text = field.string('utf8');
      return text === null ? null : JSON.parse(text);
    }
    return next();
  },
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
