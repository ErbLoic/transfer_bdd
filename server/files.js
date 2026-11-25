import { buildCreateTable, chunk, foreignKeySql, indexBlocker, indexSql, KINDS, QUOTES } from './dialects.js'
import { prepareValue } from './types.js'
import { createAnonymizer, sanitizeRules } from './anonymize.js'

// ---------- Lecture commune (anonymisation et exclusions comprises) ----------

async function* readTables(sourceDb, tables, columnRules = {}) {
  const anonymizer = createAnonymizer()
  const available = await sourceDb.listTables()
  for (const table of tables.filter((name) => available.includes(name))) {
    const rules = sanitizeRules(columnRules[table])
    const allColumns = await sourceDb.getColumns(table)
    const columns = allColumns.filter((column) => rules[column.name] !== 'exclude').map((column) => rules[column.name] === 'null' ? { ...column, nullable: true } : column)
    const foreignKeys = (await sourceDb.getForeignKeys(table)).filter((fk) => tables.includes(fk.refTable) && fk.columns.every((name) => columns.some((column) => column.name === name)))
    const indexes = sourceDb.getIndexes ? (await sourceDb.getIndexes(table)).filter((index) => !index.complex && index.columns.every((name) => columns.some((column) => column.name === name))) : []
    const batches = async function* batches() {
      for await (const batch of sourceDb.readBatches(table, allColumns)) {
        yield batch.map((row) => Object.fromEntries(columns.map((column) => [column.name, anonymizer.apply(row[column.name], column, rules[column.name])])))
      }
    }
    yield { table, columns, foreignKeys, indexes, batches }
  }
}

// ---------- JSON (format RelayDB, réimportable) ----------

const toJsonValue = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') }
  if (value instanceof Date) return value.toISOString()
  return value
}
const fromJsonValue = (value) => value && typeof value === 'object' && typeof value.$binary === 'string' ? Buffer.from(value.$binary, 'base64') : value

export async function exportJson(sourceDb, tables, columnRules) {
  const output = { format: 'relaydb', version: 1, sourceKind: sourceDb.kind, exportedAt: new Date().toISOString(), tables: [] }
  for await (const { table, columns, foreignKeys, indexes, batches } of readTables(sourceDb, tables, columnRules)) {
    const rows = []
    for await (const batch of batches()) for (const row of batch) rows.push(columns.map((column) => toJsonValue(row[column.name])))
    output.tables.push({ name: table, columns, foreignKeys, indexes, rows })
  }
  return JSON.stringify(output)
}

// Source virtuelle à partir d'un export JSON : elle passe par le même pipeline qu'une vraie base.
export function fileSource(data) {
  if (data?.format !== 'relaydb' || data.version !== 1 || !Array.isArray(data.tables)) throw new Error('Fichier non reconnu : seul un export JSON RelayDB peut être importé.')
  const byName = new Map(data.tables.map((table) => [table.name, table]))
  const get = (name) => byName.get(name) ?? (() => { throw new Error(`Table ${name} absente du fichier.`) })()
  return {
    kind: 'file',
    listTables: async () => [...byName.keys()],
    getColumns: async (name) => get(name).columns,
    getForeignKeys: async (name) => get(name).foreignKeys ?? [],
    getIndexes: async (name) => get(name).indexes ?? [],
    count: async (name) => get(name).rows.length,
    readBatches: async function* readBatches(name, columns, size = 5000) {
      const table = get(name)
      const objects = table.rows.map((values) => Object.fromEntries(table.columns.map((column, index) => [column.name, fromJsonValue(values[index])])))
      for (const batch of chunk(objects, size)) yield batch
    },
    close: async () => {},
  }
}

// ---------- CSV (une table) ----------

const csvCell = (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') value = value.toString()
  if (value instanceof Uint8Array) value = Buffer.from(value).toString('base64')
  if (value instanceof Date) value = value.toISOString()
  if (typeof value === 'object') value = JSON.stringify(value)
  const text = String(value)
  return /[",\r\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function exportCsv(sourceDb, tables, columnRules) {
  if (tables.length !== 1) throw new Error('L’export CSV porte sur une seule table : sélectionnez-en une seule, ou choisissez JSON ou SQL.')
  const lines = []
  for await (const { columns, batches } of readTables(sourceDb, tables, columnRules)) {
    lines.push(columns.map((column) => csvCell(column.name)).join(','))
    for await (const batch of batches()) for (const row of batch) lines.push(columns.map((column) => csvCell(row[column.name])).join(','))
  }
  // BOM : Excel reconnaît ainsi l'UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`
}

// ---------- SQL (script pour le moteur choisi) ----------

const hex = (value) => Buffer.from(value).toString('hex')

function literal(value, column, kind) {
  const prepared = prepareValue(value, column, kind)
  if (prepared === null || prepared === undefined) return 'NULL'
  if (typeof prepared === 'boolean') return kind === 'postgres' ? (prepared ? 'TRUE' : 'FALSE') : (prepared ? '1' : '0')
  if (typeof prepared === 'number' || typeof prepared === 'bigint') return String(prepared)
  if (Buffer.isBuffer(prepared)) return { postgres: `'\\x${hex(prepared)}'::bytea`, mysql: `X'${hex(prepared)}'`, sqlite: `X'${hex(prepared)}'`, mssql: `0x${hex(prepared)}`, oracle: `HEXTORAW('${hex(prepared)}')` }[kind]
  let text = String(prepared)
  if (['smallint', 'integer', 'bigint', 'decimal', 'float', 'double'].includes(column.type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return text
  if (kind === 'mysql') text = text.replaceAll('\\', '\\\\')
  const quoted = `'${text.replaceAll("'", "''")}'`
  if (kind === 'oracle' && ['date', 'timestamp'].includes(column.type)) return `TO_TIMESTAMP(${quoted}, 'YYYY-MM-DD HH24:MI:SS.FF')`
  if (kind === 'oracle' && column.type === 'timestamptz') return `TO_TIMESTAMP_TZ(${quoted}, 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`
  return kind === 'mssql' ? `N${quoted}` : quoted
}

export async function exportSql(sourceDb, tables, columnRules, kind) {
  if (!KINDS.includes(kind)) throw new Error(`Moteur cible inconnu pour l’export SQL : ${kind}.`)
  const quote = QUOTES[kind]
  const virtual = { kind, quote, table: quote }
  const lines = [`-- Export RelayDB pour ${kind}, ${new Date().toISOString()}`]
  if (kind === 'mysql') lines.push('SET FOREIGN_KEY_CHECKS = 0;')
  const after = []
  for await (const { table, columns, foreignKeys, indexes, batches } of readTables(sourceDb, tables, columnRules)) {
    const plan = buildCreateTable(virtual, table, columns, kind === 'sqlite' ? foreignKeys : [])
    lines.push('', `-- ${table}`, ...plan.warnings.map((warning) => `-- ! ${warning}`), `${plan.sql};`)
    const columnSql = columns.map((column) => quote(column.name)).join(', ')
    const perStatement = kind === 'oracle' ? 1 : kind === 'mssql' ? 1000 : 100
    if (plan.identity && kind === 'mssql') lines.push(`SET IDENTITY_INSERT ${quote(table)} ON;`)
    for await (const batch of batches()) {
      for (const group of chunk(batch, perStatement)) {
        const tuples = group.map((row) => `(${columns.map((column) => literal(row[column.name], column, kind)).join(', ')})`)
        lines.push(`INSERT INTO ${quote(table)} (${columnSql}) VALUES ${tuples.join(',\n  ')};`)
      }
    }
    if (plan.identity && kind === 'mssql') lines.push(`SET IDENTITY_INSERT ${quote(table)} OFF;`)
    if (plan.identity && kind === 'postgres') lines.push(`SELECT setval(pg_get_serial_sequence('${quote(table).replaceAll("'", "''")}', '${plan.identity}'), MAX(${quote(plan.identity)})) FROM ${quote(table)} HAVING MAX(${quote(plan.identity)}) IS NOT NULL;`)
    if (plan.identity && kind === 'oracle') lines.push(`ALTER TABLE ${quote(table)} MODIFY (${quote(plan.identity)} GENERATED BY DEFAULT AS IDENTITY (START WITH LIMIT VALUE));`)
    for (const index of indexes) {
      const blocker = index.columns.map((name) => indexBlocker(columns.find((column) => column.name === name), kind)).find(Boolean)
      after.push(blocker ? `-- index ${index.name} ignoré : ${blocker}` : `${indexSql(virtual, table, index)};`)
    }
    if (kind !== 'sqlite') for (const fk of foreignKeys) after.push(`ALTER TABLE ${quote(table)} ADD ${foreignKeySql(virtual, table, fk)};`)
  }
  if (after.length) lines.push('', '-- Index et clés étrangères', ...after)
  if (kind === 'mysql') lines.push('SET FOREIGN_KEY_CHECKS = 1;')
  if (kind === 'oracle') lines.push('COMMIT;')
  return `${lines.join('\n')}\n`
}
