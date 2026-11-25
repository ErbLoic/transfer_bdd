import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { maskConnection, withDatabase } from './dialects.js'
import { runTransfer } from './transfer.js'
import { cancelJob, getJob, publicJob, startJob } from './jobs.js'
import * as store from './store.js'
import { exportCsv, exportJson, exportSql, fileSource } from './files.js'

const app = express()
const port = process.env.PORT || 3001

app.use(cors())
// Limite élevée pour l'import de fichiers JSON.
app.use(express.json({ limit: '200mb' }))

const fail = (response, error, status = 400) => response.status(status).json({ ok: false, error: error.message || String(error) })

// Inspection : tables, nombre de lignes et colonnes (pour choisir l'anonymisation).
async function inspect(request, response) {
  try {
    const { connectionString } = request.body
    if (!connectionString) throw new Error('Chaîne de connexion manquante.')
    const result = await withDatabase(connectionString, async (database) => {
      const tables = []
      for (const name of await database.listTables()) {
        const columns = await database.getColumns(name)
        tables.push({
          name, rows: await database.count(name),
          columns: columns.map(({ name: column, type, nullable, primary, identity, length }) => ({ name: column, type, nullable, primary, identity, length })),
        })
      }
      return { kind: database.kind, tables }
    })
    response.json({ ok: true, ...result })
  } catch (error) { fail(response, error) }
}
app.post('/api/inspect', inspect)
app.post('/api/test', inspect)

app.get('/health', (request, response) => response.json({ ok: true }))

// Résumé enregistré dans l'historique (sans les données elles-mêmes).
const summarize = (report) => report && ({
  ok: report.ok, error: report.error, cancelled: report.cancelled, rolledBack: report.rolledBack,
  rows: report.tables.reduce((sum, table) => sum + (table.rows || 0), 0),
  tablesOk: report.tables.filter((table) => table.status === 'ok').length,
  tablesError: report.tables.filter((table) => table.status === 'error').length,
})

function launch(response, { kind, source, target, options, sourceDb }) {
  const startedAt = new Date()
  const job = startJob(async (hooks) => {
    let report = null
    let failure = null
    try {
      report = await runTransfer({ ...options, source, target, sourceDb }, hooks)
      return report
    } catch (error) { failure = error; throw error } finally {
      if (store.storeStatus().enabled) {
        await store.addHistory({
          kind, date: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
          source: source ?? null, sourceLabel: options.sourceLabel ?? null, target,
          options: { tables: options.tables, mode: options.mode, existing: options.existing, dryRun: Boolean(options.dryRun), verify: options.verify !== false, columnRules: options.columnRules || {} },
          status: failure ? 'failed' : report.ok ? 'ok' : 'error',
          error: failure?.message ?? report?.error ?? null,
          summary: summarize(report), report,
        }).catch((error) => console.error('Historique non enregistré :', error.message))
      }
    }
  })
  response.status(202).json({ ok: true, jobId: job.id })
}

const transferOptions = (body) => ({
  tables: body.tables, mode: body.mode, existing: body.existing, replaceExisting: body.replaceExisting,
  dryRun: body.dryRun, verify: body.verify, columnRules: body.columnRules, batchSize: body.batchSize,
})

app.post('/api/transfer', (request, response) => {
  const { source, target, tables } = request.body
  if (!source || !target || !Array.isArray(tables) || tables.length === 0) return fail(response, new Error('Source, cible et tables sont obligatoires.'))
  launch(response, { kind: request.body.dryRun ? 'simulation' : 'transfert', source, target, options: transferOptions(request.body) })
})

app.post('/api/import', (request, response) => {
  try {
    const { target, data, fileName } = request.body
    if (!target || !data) throw new Error('Cible et fichier sont obligatoires.')
    const sourceDb = fileSource(data)
    const tables = Array.isArray(request.body.tables) && request.body.tables.length ? request.body.tables : data.tables.map((table) => table.name)
    launch(response, { kind: 'import', source: null, target, sourceDb, options: { ...transferOptions(request.body), tables, sourceLabel: `fichier ${fileName || 'import.json'}` } })
  } catch (error) { fail(response, error) }
})

app.get('/api/jobs/:id', (request, response) => {
  const job = getJob(request.params.id)
  if (!job) return fail(response, new Error('Tâche introuvable (terminée depuis plus d’une heure ?).'), 404)
  response.json({ ok: true, job: publicJob(job) })
})

app.post('/api/jobs/:id/cancel', (request, response) => {
  const job = cancelJob(request.params.id)
  if (!job) return fail(response, new Error('Tâche introuvable.'), 404)
  response.json({ ok: true, job: publicJob(job) })
})

app.post('/api/export', async (request, response) => {
  try {
    const { source, tables, format = 'json', sqlDialect, columnRules } = request.body
    if (!source || !Array.isArray(tables) || !tables.length) throw new Error('Source et tables sont obligatoires.')
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
    const result = await withDatabase(source, async (database) => {
      if (format === 'csv') return { body: await exportCsv(database, tables, columnRules), type: 'text/csv; charset=utf-8', name: `${tables[0]}-${stamp}.csv` }
      if (format === 'sql') return { body: await exportSql(database, tables, columnRules, sqlDialect || database.kind), type: 'application/sql; charset=utf-8', name: `relaydb-${sqlDialect || database.kind}-${stamp}.sql` }
      return { body: await exportJson(database, tables, columnRules), type: 'application/json; charset=utf-8', name: `relaydb-${stamp}.json` }
    })
    response.setHeader('Content-Type', result.type)
    response.setHeader('Content-Disposition', `attachment; filename="${result.name}"`)
    response.send(result.body)
  } catch (error) { fail(response, error) }
})

// ---------- Historique et profils (chiffrés) ----------

const requireStore = (request, response, next) => store.storeStatus().enabled ? next() : response.status(503).json({ ok: false, ...store.storeStatus() })
const publicHistory = (entry) => ({
  id: entry.id, kind: entry.kind, date: entry.date, durationMs: entry.durationMs, status: entry.status, error: entry.error,
  source: entry.source ? maskConnection(entry.source) : entry.sourceLabel, target: maskConnection(entry.target),
  options: { ...entry.options, columnRules: undefined, anonymized: Object.values(entry.options?.columnRules || {}).reduce((sum, rules) => sum + Object.keys(rules).length, 0) },
  summary: entry.summary,
})

app.get('/api/store', (request, response) => response.json({ ok: true, ...store.storeStatus() }))

app.get('/api/history', requireStore, async (request, response) => {
  try { response.json({ ok: true, history: (await store.listHistory()).map(publicHistory) }) } catch (error) { fail(response, error, 500) }
})
// Détail complet, chaînes de connexion comprises, pour relancer un transfert à l'identique.
app.get('/api/history/:id', requireStore, async (request, response) => {
  try {
    const entry = await store.getHistory(request.params.id)
    if (!entry) return fail(response, new Error('Entrée introuvable.'), 404)
    response.json({ ok: true, entry })
  } catch (error) { fail(response, error, 500) }
})
app.delete('/api/history/:id', requireStore, async (request, response) => {
  try { await store.deleteHistory(request.params.id); response.json({ ok: true }) } catch (error) { fail(response, error, 500) }
})
app.delete('/api/history', requireStore, async (request, response) => {
  try { await store.deleteHistory(null); response.json({ ok: true }) } catch (error) { fail(response, error, 500) }
})

app.get('/api/profiles', requireStore, async (request, response) => {
  try { response.json({ ok: true, profiles: (await store.listProfiles()).map((profile) => ({ id: profile.id, name: profile.name, display: maskConnection(profile.connectionString) })) }) } catch (error) { fail(response, error, 500) }
})
app.get('/api/profiles/:id', requireStore, async (request, response) => {
  try {
    const profile = await store.getProfile(request.params.id)
    if (!profile) return fail(response, new Error('Profil introuvable.'), 404)
    response.json({ ok: true, profile })
  } catch (error) { fail(response, error, 500) }
})
app.post('/api/profiles', requireStore, async (request, response) => {
  try {
    const name = String(request.body.name || '').trim()
    if (!name || !request.body.connectionString) throw new Error('Nom et chaîne de connexion sont obligatoires.')
    const profile = await store.saveProfile({ name, connectionString: request.body.connectionString })
    response.json({ ok: true, profile: { id: profile.id, name: profile.name, display: maskConnection(profile.connectionString) } })
  } catch (error) { fail(response, error) }
})
app.delete('/api/profiles/:id', requireStore, async (request, response) => {
  try { await store.deleteProfile(request.params.id); response.json({ ok: true }) } catch (error) { fail(response, error, 500) }
})

app.listen(port, () => {
  console.log(`Transfer BDD API disponible sur http://localhost:${port}`)
  if (!store.storeStatus().enabled) console.warn(store.storeStatus().reason)
})
