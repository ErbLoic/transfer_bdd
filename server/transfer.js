import { connect, indexBlocker, indexName } from './dialects.js'
import { foreignKeyName } from './types.js'
import { createAnonymizer, sanitizeRules } from './anonymize.js'
import { createDigest } from './verify.js'

export const EXISTING_MODES = ['create', 'replace', 'append', 'upsert']

export class CancelledError extends Error {
  constructor() { super('Transfert annulé à la demande.'); this.cancelled = true }
}

// Cible « à blanc » : les lectures passent, les écritures sont seulement enregistrées.
function dryTarget(target, statements) {
  const record = async (sql) => { statements.push(sql.endsWith(';') ? sql : `${sql};`); return [] }
  return Object.assign(Object.create(target), {
    query: record,
    dropTable: (table) => record(`DROP TABLE IF EXISTS ${target.table(table)}`),
    insertRows: async () => {},
    deleteByKeys: async () => {},
    syncIdentity: target.syncIdentity && (async (table, column) => { statements.push(`-- recalage de l'auto-incrément ${table}.${column}`) }),
    addForeignKey: (table, fk) => record(target.foreignKeyStatement(table, fk)),
    createIndex: (table, index) => record(target.indexStatement(table, index)),
    addCheck: (table, check) => record(target.checkStatement(table, check)),
    begin: async () => {}, commit: async () => {}, rollback: async () => {},
  })
}

/*
 * Transfert complet, utilisé par l'API, l'import de fichier et les tests.
 * options : source | sourceDb, target, tables, mode (atomic|continue), existing (create|replace|append|upsert),
 *           dryRun, verify, columnRules { table: { colonne: méthode } }, batchSize
 * hooks   : onProgress(progress), isCancelled()
 *
 * Deux modes :
 * - atomic   : tout ou rien. Transaction unique sur PostgreSQL, SQL Server et SQLite ;
 *              sur MySQL et Oracle (qui valident chaque CREATE TABLE), les tables créées sont supprimées en cas d'échec.
 * - continue : chaque table est traitée séparément, les erreurs sont collectées et renvoyées à la fin.
 */
export async function runTransfer(options, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const mode = options.mode === 'continue' ? 'continue' : 'atomic'
  const existing = EXISTING_MODES.includes(options.existing) ? options.existing : (options.replaceExisting ? 'replace' : 'create')
  const dryRun = Boolean(options.dryRun)
  const verify = options.verify !== false && !dryRun
  const batchSize = Math.min(Math.max(Number(options.batchSize) || 5000, 100), 50000)
  const report = {
    mode, existing, dryRun, tables: [], foreignKeys: [], indexes: [], checks: [], verification: [], warnings: [], statements: [],
    rolledBack: false, cancelled: false,
  }
  const progress = { phase: 'connexion', table: null, tablesDone: 0, tablesTotal: 0, rowsDone: 0, rowsTotal: 0 }
  const emit = (patch = {}) => { Object.assign(progress, patch); onProgress({ ...progress }) }
  const checkCancel = () => { if (isCancelled()) throw new CancelledError() }

  emit()
  const sourceDb = options.sourceDb ?? await connect(options.source)
  try {
    const realTarget = await connect(options.target)
    try {
      await execute({ sourceDb, realTarget })
    } finally { await realTarget.close() }
  } finally { if (!options.sourceDb) await sourceDb.close() }

  report.ok = !report.error && !report.cancelled
    && !report.tables.some((item) => item.status === 'error')
    && !report.foreignKeys.some((item) => item.status === 'error')
    && !report.indexes.some((item) => item.status === 'error')
    && !report.checks.some((item) => item.status === 'error')
    && !report.verification.some((item) => item.status === 'mismatch')
  emit({ phase: 'terminé', table: null })
  return report

  async function execute({ sourceDb, realTarget }) {
    const targetDb = dryRun ? dryTarget(realTarget, report.statements) : realTarget
    const anonymizer = createAnonymizer()
    const allRules = options.columnRules || {}
    const emptyIsNull = sourceDb.kind === 'oracle' || realTarget.kind === 'oracle'

    emit({ phase: 'préparation' })
    const available = await sourceDb.listTables()
    const selected = (options.tables || []).filter((table) => available.includes(table))
    for (const table of (options.tables || []).filter((name) => !available.includes(name))) report.warnings.push(`${table} : table introuvable dans la source, ignorée.`)
    const targetTables = await realTarget.listTables()
    const sameKind = sourceDb.kind === realTarget.kind
    const hasExclusions = selected.some((table) => Object.values(sanitizeRules(allRules[table])).includes('exclude'))
    // Entre deux MySQL, la définition native est reprise telle quelle (sauf colonnes exclues).
    const native = sourceDb.kind === 'mysql' && realTarget.kind === 'mysql' && !hasExclusions

    const items = []
    for (const table of selected) {
      checkCancel()
      const rules = sanitizeRules(allRules[table])
      const allColumns = await sourceDb.getColumns(table)
      for (const column of allColumns.filter((c) => c.primary && ['null', 'exclude'].includes(rules[c.name]))) {
        report.warnings.push(`${table}.${column.name} : une clé primaire ne peut pas être vidée ni exclue, elle est hachée à la place.`)
        rules[column.name] = 'hash'
      }
      const columns = allColumns
        .filter((column) => rules[column.name] !== 'exclude')
        .map((column) => rules[column.name] === 'null' ? { ...column, nullable: true, default: null } : column)
      const kept = new Set(columns.map((column) => column.name))
      const foreignKeys = []
      if (!native) {
        for (const fk of await sourceDb.getForeignKeys(table)) {
          const refRules = sanitizeRules(allRules[fk.refTable])
          if (!selected.includes(fk.refTable)) report.warnings.push(`${table} : clé étrangère vers « ${fk.refTable} » ignorée (table non sélectionnée).`)
          else if (fk.columns.some((name) => !kept.has(name)) || fk.refColumns.some((name) => refRules[name] === 'exclude')) report.warnings.push(`${table} : clé étrangère vers « ${fk.refTable} » ignorée (colonne exclue).`)
          else foreignKeys.push(fk)
        }
      }
      const indexes = native || !sourceDb.getIndexes ? [] : await sourceDb.getIndexes(table)
      const checks = native || !sameKind || !sourceDb.getChecks ? [] : await sourceDb.getChecks(table)
      const exists = targetTables.includes(table)
      items.push({ table, rules, allColumns, columns, foreignKeys, indexes, checks, exists, rowsTotal: await sourceDb.count(table), created: false })
    }
    emit({ tablesTotal: items.length, rowsTotal: items.reduce((sum, item) => sum + item.rowsTotal, 0) })

    // Lignes source après anonymisation, renommées selon les colonnes de la cible.
    const transform = (row, item) => {
      const output = {}
      for (const column of item.writeColumns) output[column.name] = anonymizer.apply(row[column.sourceName], column, item.rules[column.sourceName])
      return output
    }

    async function copyTable(item) {
      const { table } = item
      if (item.exists && existing === 'create') throw new Error('la table existe déjà dans la cible (choisissez Remplacer, Ajouter ou Mettre à jour).')
      const create = !item.exists || existing === 'replace'
      let identity = null
      if (create) {
        if (item.exists) await targetDb.dropTable(table)
        if (native) {
          await targetDb.query(await sourceDb.nativeCreate(table))
        } else {
          const plan = targetDb.createTablePlan(table, item.columns, targetDb.inlineForeignKeys ? item.foreignKeys : [])
          report.warnings.push(...plan.warnings)
          await targetDb.query(plan.sql)
          identity = plan.identity
        }
        item.created = true
        item.writeColumns = item.columns.map((column) => ({ ...column, sourceName: column.name }))
      } else {
        // Table existante : seules les colonnes présentes des deux côtés sont copiées.
        const targetColumns = await realTarget.getColumns(table)
        item.writeColumns = []
        for (const column of item.columns) {
          const match = targetColumns.find((other) => other.name === column.name) ?? targetColumns.find((other) => other.name.toLowerCase() === column.name.toLowerCase())
          if (match) item.writeColumns.push({ ...column, name: match.name, sourceName: column.name })
          else report.warnings.push(`${table}.${column.name} : colonne absente de la table cible, ignorée.`)
        }
        identity = targetColumns.find((column) => column.identity && item.writeColumns.some((write) => write.name === column.name))?.name ?? null
      }
      const keyColumns = item.writeColumns.filter((column) => column.primary)
      const upsert = !create && existing === 'upsert'
      if (upsert && !keyColumns.length) report.warnings.push(`${table} : pas de clé primaire, les lignes sont ajoutées sans mise à jour.`)

      let copied = 0
      if (dryRun) {
        copied = item.rowsTotal
        report.statements.push(`-- ${copied} ligne${copied > 1 ? 's' : ''} ${upsert ? 'à insérer ou mettre à jour' : 'à insérer'} dans ${targetDb.table(table)}`)
        emit({ rowsDone: progress.rowsDone + copied })
      } else {
        for await (const batch of sourceDb.readBatches(table, item.allColumns, batchSize)) {
          checkCancel()
          const rows = batch.map((row) => transform(row, item))
          if (upsert && keyColumns.length) await targetDb.deleteByKeys(table, keyColumns, rows)
          await targetDb.insertRows(table, item.writeColumns, rows, { identity })
          copied += rows.length
          emit({ rowsDone: progress.rowsDone + rows.length })
        }
      }
      if (identity && copied > 0 && targetDb.syncIdentity) await targetDb.syncIdentity(table, identity)
      return copied
    }

    // Contraintes secondaires d'une table créée : index, CHECK puis clés étrangères.
    async function addConstraints(item, atomic) {
      const attempt = async (list, entry, action) => {
        try { await action(); list.push({ ...entry, status: 'ok' }) } catch (error) {
          if (atomic) { error.table = `${item.table} (${entry.name})`; throw error }
          list.push({ ...entry, status: 'error', error: error.message })
        }
      }
      const columnsByName = new Map(item.writeColumns.map((column) => [column.sourceName, column]))
      for (const index of item.indexes) {
        const entry = { table: item.table, name: indexName(item.table, index), columns: index.columns, unique: index.unique }
        if (index.complex) { report.indexes.push({ ...entry, status: 'skipped', error: 'index sur expression, partiel ou spécialisé : non transposable.' }); continue }
        const blocker = index.columns.map((name) => indexBlocker(columnsByName.get(name), realTarget.kind)).find(Boolean)
        if (blocker) { report.indexes.push({ ...entry, status: 'skipped', error: blocker }); continue }
        await attempt(report.indexes, entry, () => targetDb.createIndex(item.table, { ...index, columns: index.columns.map((name) => columnsByName.get(name).name) }))
      }
      for (const check of item.checks) await attempt(report.checks, { table: item.table, name: check.name, clause: check.clause }, () => targetDb.addCheck(item.table, check))
    }

    async function addForeignKeys(item, atomic) {
      for (const fk of item.foreignKeys) {
        const entry = { table: item.table, name: foreignKeyName(item.table, fk), references: fk.refTable, columns: fk.columns }
        const referenced = items.find((other) => other.table === fk.refTable)
        if (item.failed || referenced?.failed) { report.foreignKeys.push({ ...entry, status: 'skipped', error: 'table source ou référencée en erreur.' }); continue }
        if (!item.created) { report.foreignKeys.push({ ...entry, status: 'skipped', error: 'table existante conservée, clé non modifiée.' }); continue }
        if (targetDb.inlineForeignKeys) { report.foreignKeys.push({ ...entry, status: 'ok' }); continue }
        try {
          await targetDb.addForeignKey(item.table, fk)
          report.foreignKeys.push({ ...entry, status: 'ok' })
        } catch (error) {
          if (atomic) { error.table = `${item.table} (clé étrangère ${entry.name})`; throw error }
          report.foreignKeys.push({ ...entry, status: 'error', error: error.message })
        }
      }
    }

    const atomic = mode === 'atomic'
    if (atomic && targetDb.transactional) await targetDb.begin()
    try {
      for (const item of items) {
        emit({ phase: 'copie', table: item.table })
        const perTable = !atomic && targetDb.transactional
        if (perTable) await targetDb.begin()
        try {
          const rows = await copyTable(item)
          if (perTable) await targetDb.commit()
          report.tables.push({ table: item.table, rows, status: 'ok', action: item.created ? (item.exists ? 'remplacée' : 'créée') : (existing === 'upsert' ? 'mise à jour' : 'complétée') })
        } catch (error) {
          if (atomic) { error.table = item.table; throw error }
          // Pas de table à moitié remplie : annulation, ou suppression si le moteur ne sait pas annuler.
          if (perTable) await targetDb.rollback().catch(() => {})
          else if (item.created) await targetDb.dropTable(item.table).catch(() => {})
          item.failed = true
          report.tables.push({ table: item.table, rows: 0, status: 'error', error: error.message })
          if (error.cancelled) {
            report.cancelled = true
            for (const rest of items.slice(items.indexOf(item) + 1)) { rest.failed = true; report.tables.push({ table: rest.table, rows: 0, status: 'error', error: 'non traitée (transfert annulé).' }) }
            break
          }
        }
        emit({ tablesDone: progress.tablesDone + 1 })
      }

      if (!report.cancelled) {
        emit({ phase: 'contraintes', table: null })
        for (const item of items) if (item.created && !item.failed && !native) await addConstraints(item, atomic)
        for (const item of items) await addForeignKeys(item, atomic)
      }
      if (atomic && targetDb.transactional) await targetDb.commit()
    } catch (error) {
      if (!atomic) throw error
      if (targetDb.transactional) {
        await targetDb.rollback().catch(() => {})
        report.rolledBack = 'full'
      } else {
        for (const item of [...items].reverse()) if (item.created) await targetDb.dropTable(item.table).catch(() => {})
        report.rolledBack = 'partial'
        if (items.some((item) => item.exists && item.created)) report.warnings.push(`${targetDb.kind} ne sait pas annuler la création de tables : les tables remplacées avant l'erreur n'ont pas pu être restaurées.`)
        if (items.some((item) => !item.created && item.writeColumns)) report.warnings.push(`${targetDb.kind} valide chaque insertion : les lignes ajoutées aux tables existantes avant l'erreur sont conservées.`)
      }
      report.cancelled = Boolean(error.cancelled)
      report.tables = []
      report.foreignKeys = []
      report.indexes = []
      report.checks = []
      report.error = `${error.table ? `${error.table} : ` : ''}${error.message}`
      return
    }

    // Vérification : relecture des deux côtés et comparaison du nombre de lignes et d'une empreinte du contenu.
    if (!verify || report.cancelled) return
    emit({ phase: 'vérification', table: null })
    for (const item of items) {
      if (item.failed) continue
      if (!item.created) { report.verification.push({ table: item.table, status: 'skipped', error: 'table existante : d’autres lignes peuvent s’y trouver.' }); continue }
      emit({ table: item.table })
      try {
        const digestColumns = item.writeColumns.map((column) => ({ name: column.name, type: column.type }))
        const sourceDigest = createDigest(digestColumns, { emptyIsNull })
        for await (const batch of sourceDb.readBatches(item.table, item.allColumns, batchSize)) {
          checkCancel()
          for (const row of batch) sourceDigest.add(transform(row, item))
        }
        const targetColumns = (await realTarget.getColumns(item.table)).filter((column) => item.writeColumns.some((write) => write.name === column.name))
        const targetDigest = createDigest(digestColumns, { emptyIsNull })
        for await (const batch of realTarget.readBatches(item.table, targetColumns, batchSize)) {
          checkCancel()
          for (const row of batch) targetDigest.add(row)
        }
        const expected = sourceDigest.result()
        const actual = targetDigest.result()
        const sameCount = expected.count === actual.count
        const sameContent = expected.hash === actual.hash
        report.verification.push({
          table: item.table, expected: expected.count, actual: actual.count, sameCount, sameContent,
          status: sameCount && sameContent ? 'ok' : 'mismatch',
          error: !sameCount ? `${actual.count} ligne(s) dans la cible pour ${expected.count} attendue(s).` : (!sameContent ? 'même nombre de lignes, mais contenu différent.' : undefined),
        })
      } catch (error) {
        if (error.cancelled) { report.cancelled = true; report.warnings.push('Vérification interrompue (annulation).'); break }
        report.verification.push({ table: item.table, status: 'error', error: error.message })
      }
    }
  }
}
