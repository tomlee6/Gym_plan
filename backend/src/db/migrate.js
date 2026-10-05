/**
 * Applies SQL files in migrations/ in name order, once each. Applied files
 * are recorded in schema_migrations, so running this again is safe.
 *
 *   npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { config } from '../config.js';

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export async function migrate({ log = console.log } = {}) {
  // A separate connection with multi-statement support, used only here.
  const conn = await mysql.createConnection({
    ...config.db,
    multipleStatements: true,
  });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(200) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    const [done] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r) => r.name));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      log(`Applying ${file}`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    }
  } finally {
    await conn.end();
  }
}

/** Drops every table. Tests only. */
export async function resetDatabase() {
  if (config.isProduction) throw new Error('Refusing to reset a production database');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    const [tables] = await conn.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
      [config.db.database],
    );
    if (tables.length) {
      await conn.query(
        `SET FOREIGN_KEY_CHECKS = 0; DROP TABLE ${tables
          .map((t) => `\`${t.name}\``)
          .join(', ')}; SET FOREIGN_KEY_CHECKS = 1;`,
      );
    }
  } finally {
    await conn.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => console.log('Migrations up to date.'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
