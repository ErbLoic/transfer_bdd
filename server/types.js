// Modèle neutre partagé par tous les moteurs : types, valeurs par défaut,
// clés étrangères et formatage des valeurs.

const asNumber = (value) => value === null || value === undefined || value === '' ? undefined : Number(value)

export function toCanonicalType({ rawType, length, precision, scale, dialect }) {
  const type = String(rawType || '').toLowerCase().trim()
  const base = type.replace(/\(.*?\)/g, '').replace(/\s+unsigned$/, '').replace(/\s+/g, ' ').trim()
  const parsedArgs = type.match(/\(([^)]*)\)/)?.[1]?.split(',').map((value) => Number(value.trim()))
  // Certains pilotes renvoient ces métadonnées sous forme de chaînes.
  const len = asNumber(length) ?? parsedArgs?.[0]
  const prec = asNumber(precision) ?? parsedArgs?.[0]
  const sc = asNumber(scale) ?? parsedArgs?.[1]

  if (type === 'tinyint(1)' || ['boolean', 'bool'].includes(base) || (base === 'bit' && (!len || len === 1))) return { type: 'boolean' }
  if (['tinyint', 'smallint', 'int2', 'year', 'smallserial'].includes(base)) return { type: 'smallint' }
  // En SQLite, INTEGER stocke jusqu'à 64 bits.
  if (['int', 'integer'].includes(base) && dialect === 'sqlite') return { type: 'bigint' }
  if (['int', 'integer', 'int4', 'mediumint', 'serial'].includes(base)) return { type: 'integer' }
  if (['bigint', 'int8', 'bigserial'].includes(base)) return { type: 'bigint' }
  if (['decimal', 'numeric', 'number', 'money', 'smallmoney', 'dec', 'decimal_text'].includes(base)) {
    if (base === 'money') return { type: 'decimal', precision: 19, scale: 4 }
    if (base === 'smallmoney') return { type: 'decimal', precision: 10, scale: 4 }
    if (!prec) return { type: 'decimal' }
    // Oracle n'a pas de type entier : NUMBER(p,0) redevient un entier de taille suffisante.
    if (dialect === 'oracle' && !sc) return { type: prec <= 4 ? 'smallint' : prec <= 9 ? 'integer' : 'bigint' }
    return { type: 'decimal', precision: prec, scale: Number.isFinite(sc) ? sc : 0 }
  }
  if (['real', 'float4', 'binary_float'].includes(base)) return { type: 'float' }
  if (['float', 'double', 'double precision', 'float8', 'binary_double'].includes(base)) return { type: 'double' }
  if (['char', 'character', 'nchar', 'varchar', 'nvarchar', 'varchar2', 'nvarchar2', 'character varying', 'string'].includes(base)) {
    return len && len > 0 ? { type: 'varchar', length: len } : { type: 'text' }
  }
  if (['text', 'tinytext', 'mediumtext', 'longtext', 'ntext', 'clob', 'nclob', 'citext', 'xml', 'enum', 'set'].includes(base)) return { type: 'text' }
  if (base === 'date') return dialect === 'oracle' ? { type: 'timestamp' } : { type: 'date' }
  if (base === 'datetimeoffset' || base === 'timestamptz' || (base.startsWith('timestamp') && base.includes('with time zone') && !base.includes('local'))) return { type: 'timestamptz' }
  if (base === 'time' || base.startsWith('time ') || base === 'timetz') return { type: 'time' }
  if (['datetime', 'datetime2', 'smalldatetime'].includes(base) || base.startsWith('timestamp')) return { type: 'timestamp' }
  if (['json', 'jsonb'].includes(base)) return { type: 'json' }
  if (['blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea', 'binary', 'varbinary', 'image', 'raw', 'long raw', 'bit varying'].includes(base)) return { type: 'binary' }
  if (['uuid', 'uniqueidentifier'].includes(base)) return { type: 'uuid' }
  return { type: 'text' }
}

const typeMaps = {
  mysql: {
    boolean: () => 'TINYINT(1)', smallint: () => 'SMALLINT', integer: () => 'INT', bigint: () => 'BIGINT',
    decimal: (c) => c.precision ? `DECIMAL(${Math.min(c.precision, 65)},${Math.min(c.scale ?? 0, 30)})` : 'DECIMAL(65,30)',
    float: () => 'FLOAT', double: () => 'DOUBLE',
    varchar: (c) => c.length <= 16383 ? `VARCHAR(${c.length})` : 'LONGTEXT', text: () => 'LONGTEXT',
    date: () => 'DATE', time: () => 'TIME(6)', timestamp: () => 'DATETIME(6)', timestamptz: () => 'DATETIME(6)',
    json: () => 'JSON', binary: () => 'LONGBLOB', uuid: () => 'CHAR(36)',
  },
  postgres: {
    boolean: () => 'boolean', smallint: () => 'smallint', integer: () => 'integer', bigint: () => 'bigint',
    decimal: (c) => c.precision ? `numeric(${c.precision},${c.scale ?? 0})` : 'numeric',
    float: () => 'real', double: () => 'double precision',
    varchar: (c) => `varchar(${c.length})`, text: () => 'text',
    date: () => 'date', time: () => 'time(6)', timestamp: () => 'timestamp(6)', timestamptz: () => 'timestamptz(6)',
    json: () => 'jsonb', binary: () => 'bytea', uuid: () => 'uuid',
  },
  mssql: {
    boolean: () => 'BIT', smallint: () => 'SMALLINT', integer: () => 'INT', bigint: () => 'BIGINT',
    decimal: (c) => c.precision ? `DECIMAL(${Math.min(c.precision, 38)},${Math.min(c.scale ?? 0, 38)})` : 'DECIMAL(38,18)',
    float: () => 'REAL', double: () => 'FLOAT',
    varchar: (c) => c.length <= 4000 ? `NVARCHAR(${c.length})` : 'NVARCHAR(MAX)', text: () => 'NVARCHAR(MAX)',
    date: () => 'DATE', time: () => 'TIME(7)', timestamp: () => 'DATETIME2(7)', timestamptz: () => 'DATETIMEOFFSET(7)',
    json: () => 'NVARCHAR(MAX)', binary: () => 'VARBINARY(MAX)', uuid: () => 'UNIQUEIDENTIFIER',
  },
  // SQLite accepte n'importe quel nom de type : on garde des noms explicites pour que le type
  // d'origine soit retrouvé si la table repart vers un autre moteur. Les décimaux sont stockés
  // en texte (affinité TEXT grâce au suffixe) pour ne perdre aucun chiffre.
  sqlite: {
    boolean: () => 'BOOLEAN', smallint: () => 'SMALLINT', integer: () => 'INTEGER', bigint: () => 'BIGINT',
    decimal: (c) => c.precision ? `DECIMAL_TEXT(${c.precision},${c.scale ?? 0})` : 'DECIMAL_TEXT', float: () => 'REAL', double: () => 'DOUBLE',
    varchar: (c) => `VARCHAR(${c.length})`, text: () => 'TEXT',
    date: () => 'DATE', time: () => 'TIME', timestamp: () => 'TIMESTAMP', timestamptz: () => 'TIMESTAMPTZ',
    json: () => 'JSON', binary: () => 'BLOB', uuid: () => 'UUID',
  },
  oracle: {
    boolean: () => 'NUMBER(1)', smallint: () => 'NUMBER(5)', integer: () => 'NUMBER(10)', bigint: () => 'NUMBER(19)',
    decimal: (c) => c.precision ? `NUMBER(${Math.min(c.precision, 38)},${c.scale ?? 0})` : 'NUMBER',
    float: () => 'BINARY_FLOAT', double: () => 'BINARY_DOUBLE',
    varchar: (c) => c.length <= 4000 ? `VARCHAR2(${c.length} CHAR)` : 'CLOB', text: () => 'CLOB',
    date: () => 'DATE', time: () => 'VARCHAR2(20)', timestamp: () => 'TIMESTAMP(9)', timestamptz: () => 'TIMESTAMP(9) WITH TIME ZONE',
    json: () => 'CLOB', binary: () => 'BLOB', uuid: () => 'VARCHAR2(36)',
  },
}

export function canonicalToSql(column, dialect) {
  return typeMaps[dialect][column.type](column)
}

// ---------- Valeurs par défaut ----------

function stripOuterParens(text) {
  let current = text.trim()
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0
    let enclosesAll = true
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === '(') depth += 1
      if (current[index] === ')') depth -= 1
      if (depth === 0 && index < current.length - 1) { enclosesAll = false; break }
    }
    if (!enclosesAll) break
    current = current.slice(1, -1).trim()
  }
  return current
}

const NOW = /^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|getutcdate\(\)|sysdatetime\(\)|sysdatetimeoffset\(\)|sysutcdatetime\(\)|sysdate|systimestamp|localtimestamp(\(\d*\))?|transaction_timestamp\(\)|statement_timestamp\(\)|clock_timestamp\(\)|datetime\('now'\))$/i
const TODAY = /^(current_date|curdate\(\)|date\('now'\)|trunc\(sysdate\)|convert\(\[?date\]?,\s*getdate\(\)\)|cast\(getdate\(\) as date\))$/i

// Ramène l'expression par défaut d'un moteur à une forme neutre.
// `literal` : la valeur est une constante brute (MySQL 8 hors expressions).
export function parseDefault(raw, { literal = false } = {}) {
  if (raw === null || raw === undefined) return null
  const original = String(raw).trim()
  if (!original) return null
  if (literal) return /^null$/i.test(original) ? null : { kind: 'literal', value: original }
  let text = stripOuterParens(original.replace(/\\'/g, "'"))
  let previous
  do { previous = text; text = stripOuterParens(text.replace(/::[a-z_ "]+(\(\d+(,\s*\d+)?\))?(\[\])?$/i, '')) } while (text !== previous)
  if (/nextval\s*\(|\.nextval$|iseq\$\$/i.test(text)) return { kind: 'identity' }
  if (/^null$/i.test(text)) return null
  if (NOW.test(text)) return { kind: 'now' }
  if (TODAY.test(text)) return { kind: 'today' }
  if (/^(true|false)$/i.test(text)) return { kind: 'literal', value: text.toLowerCase() }
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return { kind: 'literal', value: text }
  const quoted = text.match(/^(?:N|_\w+\s*)?'((?:[^']|'')*)'$/s)
  if (quoted) return { kind: 'literal', value: quoted[1].replaceAll("''", "'") }
  if (/^b'[01]+'$/i.test(text)) return { kind: 'literal', value: text }
  return { kind: 'unsupported', raw: original }
}

const NUMERIC_TYPES = ['smallint', 'integer', 'bigint', 'decimal', 'float', 'double']
const TEMPORAL_TYPES = ['date', 'time', 'timestamp', 'timestamptz']

// Traduit une valeur par défaut neutre dans la syntaxe du moteur cible (null si impossible).
export function renderDefault(defaultValue, column, dialect) {
  if (!defaultValue) return null
  if (defaultValue.kind === 'now' || defaultValue.kind === 'today') {
    const today = defaultValue.kind === 'today' || column.type === 'date'
    if (today && ['date', 'timestamp', 'timestamptz'].includes(column.type)) {
      return { postgres: 'CURRENT_DATE', mysql: '(CURRENT_DATE)', mssql: 'CAST(GETDATE() AS DATE)', sqlite: 'CURRENT_DATE', oracle: 'TRUNC(SYSDATE)' }[dialect]
    }
    if (column.type === 'timestamp') return { postgres: 'CURRENT_TIMESTAMP', mysql: 'CURRENT_TIMESTAMP(6)', mssql: 'SYSDATETIME()', sqlite: 'CURRENT_TIMESTAMP', oracle: 'SYSTIMESTAMP' }[dialect]
    if (column.type === 'timestamptz') return { postgres: 'CURRENT_TIMESTAMP', mysql: 'CURRENT_TIMESTAMP(6)', mssql: 'SYSDATETIMEOFFSET()', sqlite: 'CURRENT_TIMESTAMP', oracle: 'SYSTIMESTAMP' }[dialect]
    return null
  }
  if (defaultValue.kind !== 'literal') return null
  const value = defaultValue.value
  if (column.type === 'boolean') {
    const normalized = value.toLowerCase()
    const truthy = ['1', 'true', 't', 'y', 'yes', "b'1'"].includes(normalized)
    const falsy = ['0', 'false', 'f', 'n', 'no', "b'0'"].includes(normalized)
    if (!truthy && !falsy) return null
    return dialect === 'postgres' ? (truthy ? 'TRUE' : 'FALSE') : (truthy ? '1' : '0')
  }
  if (NUMERIC_TYPES.includes(column.type)) return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value) ? value : null
  if (column.type === 'binary') return null
  // Oracle convertirait une date littérale selon les réglages de la session qui insère : trop fragile.
  if (dialect === 'oracle' && TEMPORAL_TYPES.includes(column.type)) return null
  const quoted = `'${value.replaceAll("'", "''")}'`
  if (dialect === 'mssql') return `N${quoted}`
  // MySQL n'accepte une constante sur TEXT/JSON que sous forme d'expression entre parenthèses.
  if (dialect === 'mysql' && /TEXT|JSON|BLOB/.test(canonicalToSql(column, 'mysql'))) return `(${quoted})`
  return quoted
}

// ---------- Clés étrangères ----------

const PG_RULES = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

export function normalizeRule(rule) {
  if (!rule) return 'NO ACTION'
  if (PG_RULES[rule]) return PG_RULES[rule]
  return String(rule).toUpperCase().replaceAll('_', ' ').trim()
}

// Regroupe des lignes « une par colonne » en clés étrangères complètes.
export function groupForeignKeys(rows) {
  const byName = new Map()
  for (const row of rows) {
    const key = String(row.name)
    if (!byName.has(key)) byName.set(key, { name: row.name, columns: [], refTable: row.refTable, refColumns: [], onDelete: normalizeRule(row.onDelete), onUpdate: normalizeRule(row.onUpdate) })
    const fk = byName.get(key)
    fk.columns.push(row.col)
    fk.refColumns.push(row.refCol)
  }
  return [...byName.values()]
}

export function foreignKeyName(table, fk) {
  return String(fk.name || `fk_${table}_${fk.columns.join('_')}`).slice(0, 60)
}

export function renderForeignKeyActions(fk, dialect) {
  const parts = []
  const onDelete = dialect === 'mssql' && fk.onDelete === 'RESTRICT' ? 'NO ACTION' : fk.onDelete
  if (dialect === 'oracle') {
    if (['CASCADE', 'SET NULL'].includes(onDelete)) parts.push(`ON DELETE ${onDelete}`)
    return parts.join(' ')
  }
  if (onDelete !== 'NO ACTION') parts.push(`ON DELETE ${onDelete}`)
  const onUpdate = dialect === 'mssql' && fk.onUpdate === 'RESTRICT' ? 'NO ACTION' : fk.onUpdate
  if (onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${onUpdate}`)
  return parts.join(' ')
}

// ---------- Valeurs ----------

const TEMPORAL = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/

export function parseTemporal(value) {
  if (value instanceof Date) {
    const iso = value.toISOString()
    return { date: iso.slice(0, 10), time: iso.slice(11, 19), frac: iso.slice(19, 23), offset: '+00:00' }
  }
  const match = String(value).trim().match(TEMPORAL)
  if (!match) return null
  const [, date, time, frac = '', rawOffset] = match
  let offset = null
  if (rawOffset) {
    if (rawOffset === 'Z') offset = '+00:00'
    else {
      const digits = rawOffset.replace(':', '')
      offset = `${digits.slice(0, 3)}:${digits.slice(3, 5) || '00'}`
    }
  }
  return { date, time: time ? (time.length === 5 ? `${time}:00` : time) : null, frac, offset }
}

// Décale une date-heure vers UTC sans toucher aux fractions de seconde (MySQL n'a pas de fuseau).
export function toUtc(parts) {
  if (!parts.offset || parts.offset === '+00:00') return parts
  const sign = parts.offset.startsWith('-') ? -1 : 1
  const [hours, minutes] = parts.offset.slice(1).split(':').map(Number)
  const local = Date.parse(`${parts.date}T${parts.time || '00:00:00'}Z`)
  const iso = new Date(local - sign * (hours * 60 + minutes) * 60000).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), frac: parts.frac, offset: '+00:00' }
}

const FRACTION_DIGITS = { mysql: 6, postgres: 6, mssql: 7, sqlite: 9, oracle: 9 }

function formatTemporal(value, column, dialect) {
  let parts = parseTemporal(value)
  if (!parts) return value
  const frac = parts.frac ? parts.frac.slice(0, FRACTION_DIGITS[dialect] + 1) : ''
  if (column.type === 'date' && dialect !== 'oracle') return parts.date
  if (column.type === 'timestamptz') {
    if (dialect === 'mysql') { parts = toUtc(parts); return `${parts.date} ${parts.time || '00:00:00'}${frac}` }
    const offset = parts.offset || '+00:00'
    const separator = ['mssql', 'oracle'].includes(dialect) ? ' ' : ''
    return `${parts.date} ${parts.time || '00:00:00'}${frac || (dialect === 'oracle' ? '.0' : '')}${separator}${offset}`
  }
  // Date-heure sans fuseau : une éventuelle valeur absolue est ramenée en UTC.
  if (parts.offset && parts.offset !== '+00:00') parts = toUtc(parts)
  return `${parts.date} ${parts.time || '00:00:00'}${frac || (dialect === 'oracle' ? '.0' : '')}`
}

// Adapte une valeur lue dans la source pour qu'elle soit acceptée par la cible, sans perte.
export function prepareValue(value, column, dialect) {
  if (value === null || value === undefined) return null
  // Entiers SQLite lus en BigInt : nombre si sans perte, sinon chaîne.
  if (typeof value === 'bigint' && dialect !== 'sqlite') value = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  // SQLite renvoie les BLOB en Uint8Array, les autres pilotes attendent un Buffer.
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) value = Buffer.from(value)
  if (column.type === 'boolean') {
    const truthy = Buffer.isBuffer(value) ? value[0] !== 0 : value === true || value === 1 || value === 1n || ['1', 't', 'true', 'y'].includes(String(value).toLowerCase())
    return ['sqlite', 'oracle', 'mysql'].includes(dialect) ? (truthy ? 1 : 0) : truthy
  }
  if (column.type === 'json' && typeof value !== 'string') return JSON.stringify(value)
  if (['date', 'timestamp', 'timestamptz'].includes(column.type)) return formatTemporal(value, column, dialect)
  if (column.type === 'time') {
    if (value instanceof Date) return value.toISOString().slice(11, 23)
    const text = String(value)
    return dialect === 'mssql' ? text.replace(/(\.\d{7})\d+/, '$1') : text
  }
  if (dialect === 'sqlite' && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value)
  return value
}
