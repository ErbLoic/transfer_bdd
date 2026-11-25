// Chaîne entre de vrais moteurs. Chaque moteur est testé si sa variable est définie :
// RELAYDB_TEST_POSTGRES, RELAYDB_TEST_MYSQL, RELAYDB_TEST_MSSQL, RELAYDB_TEST_ORACLE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runTransfer } from '../server/transfer.js'
import { connect } from '../server/dialects.js'
import { createDigest } from '../server/verify.js'
import { createFixture, tempDir } from './fixture.mjs'

const ENGINES = ['POSTGRES', 'MYSQL', 'MSSQL', 'ORACLE']
  .map((name) => ({ name: name.toLowerCase(), url: process.env[`RELAYDB_TEST_${name}`] }))
  .filter((engine) => engine.url)

const TABLES = ['categories', 'produits']
const dir = tempDir()
const origin = `sqlite://${join(dir, 'origin.db')}`
const back = `sqlite://${join(dir, 'back.db')}`
createFixture(join(dir, 'origin.db'), { products: 1500 })

async function digestOf(connectionString, table, reference) {
  const db = await connect(connectionString)
  try {
    const columns = await db.getColumns(table)
    const digest = createDigest(reference.map((column) => ({ name: column.name, type: column.type })), { emptyIsNull: true })
    for await (const batch of db.readBatches(table, columns, 400)) for (const row of batch) digest.add(row)
    return digest.result()
  } finally { await db.close() }
}

test('chaîne SQLite → moteurs disponibles → SQLite, sans perte', { skip: ENGINES.length === 0 && 'aucun moteur configuré' }, async (t) => {
  const hops = [origin, ...ENGINES.map((engine) => engine.url), back]
  for (let index = 0; index < hops.length - 1; index += 1) {
    const label = `${hops[index].split(':')[0]} → ${hops[index + 1].split(':')[0]}`
    await t.test(label, async () => {
      const report = await runTransfer({ source: hops[index], target: hops[index + 1], tables: TABLES, existing: 'replace', batchSize: 400 })
      assert.equal(report.error, undefined, report.error)
      assert.ok(report.tables.every((item) => item.status === 'ok'), JSON.stringify(report.tables))
      assert.ok(report.verification.every((item) => item.status === 'ok'), JSON.stringify(report.verification))
      assert.ok(report.foreignKeys.every((item) => item.status === 'ok'), JSON.stringify(report.foreignKeys))
      assert.ok(report.indexes.every((item) => item.status !== 'error'), JSON.stringify(report.indexes))
    })
  }
  await t.test('retour identique à l’origine', async () => {
    const db = await connect(origin)
    try {
      for (const table of TABLES) {
        const reference = await db.getColumns(table)
        assert.deepEqual(await digestOf(back, table, reference), await digestOf(origin, table, reference), table)
      }
    } finally { await db.close() }
  })
})

for (const engine of ENGINES) {
  test(`${engine.name} : mise à jour, simulation et annulation`, async () => {
    await runTransfer({ source: origin, target: engine.url, tables: TABLES, existing: 'replace' })
    const upsert = await runTransfer({ source: origin, target: engine.url, tables: TABLES, existing: 'upsert', batchSize: 500 })
    assert.equal(upsert.ok, true, JSON.stringify(upsert.error ?? upsert.tables))
    const db = await connect(engine.url)
    try { assert.equal(await db.count('produits'), 1500) } finally { await db.close() }

    const dry = await runTransfer({ source: origin, target: engine.url, tables: TABLES, existing: 'replace', dryRun: true })
    assert.ok(dry.statements.some((sql) => sql.startsWith('CREATE TABLE')))

    let updates = 0
    const cancelled = await runTransfer({ source: origin, target: engine.url, tables: TABLES, existing: 'replace', batchSize: 200 }, {
      onProgress: (p) => { if (p.phase === 'copie') updates += 1 }, isCancelled: () => updates > 3,
    })
    assert.equal(cancelled.cancelled, true)
  })
}
