// Tests sans serveur externe : SQLite vers SQLite (node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runTransfer } from '../server/transfer.js'
import { connect } from '../server/dialects.js'
import { exportCsv, exportJson, exportSql, fileSource } from '../server/files.js'
import { BIG, PRICE, createFixture, tempDir } from './fixture.mjs'

const dir = tempDir()
const sourcePath = join(dir, 'source.db')
createFixture(sourcePath)
const source = `sqlite://${sourcePath}`
const target = (name) => `sqlite://${join(dir, `${name}.db`)}`
const TABLES = ['categories', 'produits']
const open = (name) => new DatabaseSync(join(dir, `${name}.db`))
const tableCount = (name) => { const db = open(name); const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n; db.close(); return n }

test('transfert complet vérifié, avec index, clé étrangère et lecture par lots', async () => {
  const report = await runTransfer({ source, target: target('copy'), tables: TABLES, batchSize: 250 })
  assert.equal(report.ok, true, JSON.stringify(report.error ?? report.verification))
  assert.deepEqual(report.tables.map((t) => t.rows), [3, 1200])
  assert.ok(report.verification.every((v) => v.status === 'ok'))
  assert.ok(report.indexes.some((i) => i.columns.includes('code') && i.unique && i.status === 'ok'))
  assert.equal(report.foreignKeys[0].status, 'ok')
  const db = open('copy')
  const statement = db.prepare('SELECT price, big FROM produits WHERE id = 1')
  statement.setReadBigInts(true)
  const row = statement.get()
  db.close()
  assert.equal(row.price, PRICE)
  assert.equal(BigInt(row.big), BIG)
})

test('simulation : SQL listé, rien écrit', async () => {
  const report = await runTransfer({ source, target: target('dry'), tables: TABLES, dryRun: true })
  assert.equal(report.ok, true)
  assert.ok(report.statements.some((sql) => sql.startsWith('CREATE TABLE "produits"')))
  assert.ok(report.statements.some((sql) => sql.startsWith('CREATE UNIQUE INDEX')))
  assert.equal(tableCount('dry'), 0)
})

test('anonymisation : exclusion, valeurs fictives, vérification sur les données transformées', async () => {
  const report = await runTransfer({
    source, target: target('anon'), tables: TABLES,
    columnRules: { produits: { email: 'fake', data: 'exclude', label: 'hash', uid: 'mask', id: 'exclude' } },
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.ok(report.warnings.some((w) => w.includes('produits.id')))
  const db = open('anon')
  const columns = db.prepare('PRAGMA table_info(produits)').all().map((c) => c.name)
  const rows = db.prepare('SELECT email, label FROM produits WHERE email IS NOT NULL LIMIT 5').all()
  db.close()
  assert.ok(!columns.includes('data'))
  assert.ok(rows.every((r) => /^user_[0-9a-f]{8}@example\.invalid$/.test(r.email)))
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.label)))
})

test('mise à jour par clé primaire et mode « continuer »', async () => {
  const name = 'upsert'
  await runTransfer({ source, target: target(name), tables: TABLES })
  const src = new DatabaseSync(sourcePath)
  src.prepare("UPDATE categories SET name = 'Livres modifiés' WHERE id = 1").run()
  src.close()
  try {
    const conflict = await runTransfer({ source, target: target(name), tables: TABLES, mode: 'continue' })
    assert.equal(conflict.ok, false)
    assert.ok(conflict.tables.every((t) => t.status === 'error' && t.error.includes('existe déjà')))
    const report = await runTransfer({ source, target: target(name), tables: ['categories'], existing: 'upsert' })
    assert.equal(report.ok, true, JSON.stringify(report))
    const db = open(name)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 3)
    assert.equal(db.prepare('SELECT name FROM categories WHERE id = 1').get().name, 'Livres modifiés')
    db.close()
  } finally {
    const restore = new DatabaseSync(sourcePath)
    restore.prepare("UPDATE categories SET name = 'Livres' WHERE id = 1").run()
    restore.close()
  }
})

test('annulation en tout ou rien : la cible reste vide', async () => {
  let updates = 0
  const report = await runTransfer({ source, target: target('cancel'), tables: TABLES, batchSize: 100 }, {
    onProgress: (p) => { if (p.phase === 'copie') updates += 1 },
    isCancelled: () => updates > 3,
  })
  assert.equal(report.cancelled, true)
  assert.equal(report.rolledBack, 'full')
  assert.equal(tableCount('cancel'), 0)
})

test('export JSON puis import vérifié ; exports SQL et CSV', async () => {
  const db = await connect(source)
  try {
    const json = JSON.parse(await exportJson(db, TABLES, {}))
    const report = await runTransfer({ sourceDb: fileSource(json), target: target('imported'), tables: TABLES })
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.ok(report.verification.every((v) => v.status === 'ok'))
    for (const kind of ['postgres', 'mysql', 'mssql', 'oracle', 'sqlite']) {
      const sql = await exportSql(db, ['categories'], {}, kind)
      assert.match(sql, /CREATE TABLE/)
      assert.match(sql, /INSERT INTO/)
    }
    const csv = await exportCsv(db, ['categories'], {})
    assert.equal(csv.trim().split('\r\n').length, 4)
    await assert.rejects(() => exportCsv(db, TABLES, {}), /une seule table/)
  } finally { await db.close() }
})
