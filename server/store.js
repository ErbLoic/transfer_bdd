import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/*
 * Historique des transferts et profils de connexion, chiffrés sur disque.
 * Ils contiennent des identifiants : le fichier est chiffré en AES-256-GCM (confidentialité et
 * détection de toute modification) avec une clé dérivée par scrypt de RELAYDB_SECRET_KEY.
 * Sans cette variable, rien n'est enregistré.
 *
 * Format : "RDB1" | sel (16 o) | IV (12 o) | tag (16 o) | données chiffrées
 */
const MAGIC = Buffer.from('RDB1')
const MAX_HISTORY = 200
const FILE = resolve(process.env.RELAYDB_STORE_FILE || 'data/relaydb-store.enc')
const SECRET = process.env.RELAYDB_SECRET_KEY || ''

export const storeStatus = () => SECRET.length >= 32
  ? { enabled: true }
  : { enabled: false, reason: 'Historique désactivé : définissez RELAYDB_SECRET_KEY (32 caractères minimum) dans le fichier .env.' }

let cachedKey = null
const keyFor = (salt) => {
  if (cachedKey?.salt.equals(salt)) return cachedKey.key
  const key = scryptSync(SECRET, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  cachedKey = { salt, key }
  return key
}

function encrypt(data, salt) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(salt), iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

function decrypt(buffer) {
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error('Fichier d’historique non reconnu.')
  const salt = buffer.subarray(4, 20)
  const decipher = createDecipheriv('aes-256-gcm', keyFor(salt), buffer.subarray(20, 32))
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(buffer.subarray(32, 48))
  try {
    return { salt, data: JSON.parse(Buffer.concat([decipher.update(buffer.subarray(48)), decipher.final()]).toString('utf8')) }
  } catch {
    throw new Error('Impossible de déchiffrer l’historique : clé RELAYDB_SECRET_KEY différente ou fichier altéré.')
  }
}

async function load() {
  if (!storeStatus().enabled) throw new Error(storeStatus().reason)
  try {
    return decrypt(await readFile(FILE))
  } catch (error) {
    if (error.code === 'ENOENT') return { salt: randomBytes(16), data: { history: [], profiles: [] } }
    throw error
  }
}

// Écritures sérialisées et atomiques (fichier temporaire puis renommage).
let queue = Promise.resolve()
function update(change) {
  const run = queue.then(async () => {
    const { salt, data } = await load()
    const result = change(data)
    await mkdir(dirname(FILE), { recursive: true })
    const temporary = `${FILE}.${process.pid}.tmp`
    await writeFile(temporary, encrypt(data, salt), { mode: 0o600 })
    await rename(temporary, FILE)
    return result
  })
  queue = run.catch(() => {})
  return run
}

const read = async () => (await queue.then(load)).data

export const listHistory = async () => (await read()).history
export const getHistory = async (id) => (await read()).history.find((entry) => entry.id === id)
export const addHistory = (entry) => update((data) => {
  const saved = { id: randomUUID(), ...entry }
  data.history = [saved, ...data.history].slice(0, MAX_HISTORY)
  return saved
})
export const deleteHistory = (id) => update((data) => { data.history = id ? data.history.filter((entry) => entry.id !== id) : [] })

export const listProfiles = async () => (await read()).profiles
export const getProfile = async (id) => (await read()).profiles.find((profile) => profile.id === id)
export const saveProfile = ({ name, connectionString }) => update((data) => {
  const existing = data.profiles.find((profile) => profile.name === name)
  if (existing) { existing.connectionString = connectionString; existing.updatedAt = new Date().toISOString(); return existing }
  const profile = { id: randomUUID(), name, connectionString, createdAt: new Date().toISOString() }
  data.profiles.push(profile)
  return profile
})
export const deleteProfile = (id) => update((data) => { data.profiles = data.profiles.filter((profile) => profile.id !== id) })
