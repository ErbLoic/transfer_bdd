import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tempDir } from './fixture.mjs'

const file = join(tempDir(), 'store.enc')
process.env.RELAYDB_STORE_FILE = file
// Clé de test générée à la volée, jamais écrite.
process.env.RELAYDB_SECRET_KEY = randomBytes(48).toString('base64')
const store = await import('../server/store.js')

test('historique chiffré : relu correctement, illisible sur disque', async () => {
  const fakeSecret = `pw-${randomBytes(6).toString('hex')}`
  const connection = `postgresql://app:${fakeSecret}@localhost:5432/base`
  await store.addHistory({ kind: 'transfert', source: connection, target: 'sqlite:///data/x.db' })
  await store.saveProfile({ name: 'prod', connectionString: connection })
  const history = await store.listHistory()
  assert.equal(history[0].source, connection)
  assert.equal((await store.listProfiles())[0].connectionString, connection)
  const raw = readFileSync(file)
  assert.equal(raw.subarray(0, 4).toString(), 'RDB1')
  assert.ok(!raw.includes(fakeSecret))
  assert.ok(!raw.includes('postgresql'))
  await store.deleteHistory(history[0].id)
  assert.equal((await store.listHistory()).length, 0)
})
