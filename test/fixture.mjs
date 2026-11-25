import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'relaydb-test-'))

export const PRICE = '123456789012345678.123456789012'
export const BIG = 9223372036854775807n

// Base SQLite de référence : types variés, défauts, index, clé étrangère, plusieurs lots de lignes.
export function createFixture(path, { products = 1200 } = {}) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL DEFAULT 'divers', code VARCHAR(20));
    CREATE UNIQUE INDEX categories_code_unique ON categories (code);
    CREATE TABLE produits (
      id INTEGER PRIMARY KEY,
      category_id BIGINT REFERENCES categories (id) ON DELETE CASCADE,
      label VARCHAR(100) NOT NULL,
      price DECIMAL_TEXT(30,12), big BIGINT, active BOOLEAN NOT NULL DEFAULT 1,
      created TIMESTAMP, created_tz TIMESTAMPTZ, day DATE, at TIME,
      meta JSON, data BLOB, uid UUID, email VARCHAR(120)
    );
    CREATE INDEX produits_label_idx ON produits (label);
  `)
  const category = db.prepare('INSERT INTO categories (id, name, code) VALUES (?, ?, ?)')
  category.run(1, 'Livres', 'LIV')
  category.run(2, 'Musique', 'MUS')
  category.run(3, 'Jeux', null)
  const product = db.prepare(`INSERT INTO produits (id, category_id, label, price, big, active, created, created_tz, day, at, meta, data, uid, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (let id = 1; id <= products; id += 1) {
    const hex = id.toString(16).padStart(12, '0')
    product.run(
      id, (id % 3) + 1, `Produit n°${id} « été » ${'é'.repeat(id % 5)}`,
      id === 1 ? PRICE : `${id}.${String(id % 1000).padStart(3, '0')}`,
      id === 1 ? BIG : BigInt(id) * 1000000007n,
      id % 2,
      `2024-05-06 07:08:09.${String(123456 + id).slice(-6)}`,
      `2024-05-06 07:08:09.123456${id % 2 ? '+02:00' : '-05:30'}`,
      '2024-05-06', '10:11:12.123456',
      JSON.stringify({ id, tags: ['a', 'b'], nested: { ok: true } }),
      id % 10 === 0 ? null : new Uint8Array([0, 1, 2, 255, id % 256]),
      `0000${hex.slice(0, 4)}-0000-4000-8000-${hex}`,
      id % 7 === 0 ? null : `client${id}@exemple.fr`,
    )
  }
  db.exec('COMMIT')
  db.close()
}
