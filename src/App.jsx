import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { api, download, followJob } from './api.js'
import { ConnectionCard, HistoryPanel, ProgressPanel, Report, Segmented, TablePicker } from './components.jsx'

const ENGINE_HINT = 'MySQL, MariaDB, PostgreSQL, SQL Server, Oracle ou SQLite · ?schema=nom pour un autre schéma'

function App() {
  const [source, setSource] = useState('postgresql://utilisateur:motdepasse@host.docker.internal:5432/ma_bdd')
  const [target, setTarget] = useState('sqlserver://sa:motdepasse@host.docker.internal:1433/ma_bdd?trustServerCertificate=true')
  const [tables, setTables] = useState([])
  const [selected, setSelected] = useState([])
  const [rules, setRules] = useState({})
  const [mode, setMode] = useState('atomic')
  const [existing, setExisting] = useState('create')
  const [verify, setVerify] = useState(true)
  const [exportFormat, setExportFormat] = useState('json')
  const [sqlDialect, setSqlDialect] = useState('postgres')
  const [status, setStatus] = useState({ type: 'idle', text: '' })
  const [job, setJob] = useState(null)
  const [report, setReport] = useState(null)
  const [store, setStore] = useState({ enabled: false })
  const [history, setHistory] = useState([])
  const [profiles, setProfiles] = useState([])
  const fileInput = useRef(null)
  const busy = status.type === 'loading'

  const refreshStore = useCallback(async () => {
    try {
      const state = await api('store', { method: 'GET' })
      setStore(state)
      if (!state.enabled) return
      const [{ history: entries }, { profiles: saved }] = await Promise.all([api('history', { method: 'GET' }), api('profiles', { method: 'GET' })])
      setHistory(entries); setProfiles(saved)
    } catch (error) { setStore({ enabled: false, reason: error.message }) }
  }, [])
  // Chargement initial de l'historique et des profils chiffrés.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refreshStore() }, [refreshStore])

  const inspectSource = async () => {
    setStatus({ type: 'loading', text: 'Connexion à la source...' }); setReport(null)
    try {
      const data = await api('inspect', { body: { connectionString: source } })
      setTables(data.tables)
      setSelected(data.tables.map((table) => table.name))
      setRules((current) => Object.fromEntries(Object.entries(current).filter(([name]) => data.tables.some((table) => table.name === name))))
      setStatus({ type: 'success', text: `${data.tables.length} table${data.tables.length > 1 ? 's' : ''} trouvée${data.tables.length > 1 ? 's' : ''} · ${data.kind}` })
    } catch (error) { setStatus({ type: 'error', text: error.message }); setTables([]) }
  }

  const activeRules = () => Object.fromEntries(Object.entries(rules).filter(([name, tableRules]) => selected.includes(name) && Object.keys(tableRules).length))

  const run = async (path, body, label) => {
    setStatus({ type: 'loading', text: `${label} en cours...` }); setReport(null); setJob(null)
    try {
      const { jobId } = await api(path, { body })
      const finished = await followJob(jobId, setJob)
      if (finished.status === 'failed') { setStatus({ type: 'error', text: finished.error }); return }
      const result = finished.report
      setReport(result)
      if (result.cancelled) setStatus({ type: 'error', text: result.rolledBack === 'full' ? 'Annulé : tout a été défait.' : 'Transfert annulé.' })
      else if (result.error) setStatus({ type: 'error', text: result.rolledBack === 'full' ? 'Échec : tout a été annulé.' : 'Échec : les tables créées ont été supprimées.' })
      else if (!result.ok) setStatus({ type: 'error', text: `${label} terminé avec des erreurs.` })
      else setStatus({ type: 'success', text: result.dryRun ? 'Simulation terminée : relisez le rapport avant de lancer.' : `${label} terminé${result.verification?.length ? ' et vérifié' : ''}.` })
    } catch (error) { setStatus({ type: 'error', text: error.message }) } finally { setJob(null); refreshStore() }
  }

  const transferBody = (dryRun) => ({ source, target, tables: selected, mode, existing, verify, dryRun, columnRules: activeRules() })
  const transfer = () => run('transfer', transferBody(false), 'Transfert')
  const simulate = () => run('transfer', transferBody(true), 'Simulation')

  const cancel = async () => {
    if (!job) return
    try { setJob((await api(`jobs/${job.id}/cancel`)).job) } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }

  const exportData = async () => {
    setStatus({ type: 'loading', text: 'Export en cours...' })
    try {
      const name = await download('export', { source, tables: selected, format: exportFormat, sqlDialect, columnRules: activeRules() })
      setStatus({ type: 'success', text: `Fichier ${name} téléchargé.` })
    } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }

  const importFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    let data
    try { data = JSON.parse(await file.text()) } catch { setStatus({ type: 'error', text: 'Le fichier n’est pas un JSON valide.' }); return }
    run('import', { target, data, fileName: file.name, mode, existing, verify }, 'Import')
  }

  // ---------- Profils ----------
  const pickProfile = (setter) => async (id) => {
    try { setter((await api(`profiles/${id}`, { method: 'GET' })).profile.connectionString) } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }
  const saveProfile = async (connectionString) => {
    const name = window.prompt('Nom du profil (les identifiants seront chiffrés sur le serveur) :')
    if (!name) return
    try { await api('profiles', { body: { name, connectionString } }); await refreshStore(); setStatus({ type: 'success', text: `Profil « ${name} » enregistré.` }) } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }
  const deleteProfile = async (id) => {
    if (!window.confirm('Supprimer définitivement ce profil ?')) return
    try { await api(`profiles/${id}`, { method: 'DELETE' }); await refreshStore() } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }

  // ---------- Historique ----------
  const showEntry = async (id) => {
    try { const { entry } = await api(`history/${id}`, { method: 'GET' }); setReport(entry.report ?? { ok: false, error: entry.error, tables: [] }); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }
  const reuseEntry = async (id) => {
    try {
      const { entry } = await api(`history/${id}`, { method: 'GET' })
      if (entry.source) setSource(entry.source)
      setTarget(entry.target)
      setMode(entry.options.mode || 'atomic')
      setExisting(entry.options.existing || 'create')
      setVerify(entry.options.verify !== false)
      setRules(entry.options.columnRules || {})
      setSelected(entry.options.tables || [])
      setStatus({ type: 'success', text: 'Paramètres repris : inspectez la source pour afficher les tables, puis relancez.' })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }
  const deleteEntry = async (id) => {
    if (!window.confirm('Supprimer définitivement cette entrée de l’historique ?')) return
    try { await api(`history/${id}`, { method: 'DELETE' }); await refreshStore() } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }
  const clearHistory = async () => {
    if (!window.confirm('Effacer définitivement tout l’historique ? Cette action est irréversible.')) return
    try { await api('history', { method: 'DELETE' }); await refreshStore() } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }

  const profileProps = { profiles, storeEnabled: store.enabled, onDeleteProfile: deleteProfile }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">↗</span><span>Relay<span className="brand-accent">DB</span></span></div>
        <span className="version">LOCAL TOOL · v2.0</span>
      </header>

      <section className="intro">
        <p className="eyebrow">Migration workspace</p>
        <h1>Déplacer une base,<br /><em>sans perdre le fil.</em></h1>
        <p className="intro-copy">Connectez une source et une cible. Inspectez les tables, anonymisez ce qui doit l’être, simulez, puis lancez le transfert : il est vérifié ligne à ligne à l’arrivée.</p>
      </section>

      <section className="connections">
        <ConnectionCard step="01" title="Base source" accent="source-card" id="source" value={source} onChange={setSource} hint={`${ENGINE_HINT} · lecture seule recommandée`}
          onPickProfile={pickProfile(setSource)} onSaveProfile={() => saveProfile(source)} {...profileProps} />
        <div className="transfer-arrow">→</div>
        <ConnectionCard step="02" title="Base cible" accent="target-card" id="target" value={target} onChange={setTarget} hint="Tout moteur pris en charge · les tables absentes sont créées"
          onPickProfile={pickProfile(setTarget)} onSaveProfile={() => saveProfile(target)} {...profileProps} />
      </section>

      <section className="workspace-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">03 · Sélection</p><h2>Que voulez-vous emporter ?</h2></div>
          <button className="button button-outline" onClick={inspectSource} disabled={!source || busy}>↻ Inspecter la source</button>
        </div>
        {tables.length === 0
          ? <div className="empty-state"><span className="empty-icon">⌁</span><p>Inspectez la source pour afficher ses tables et leurs colonnes.</p></div>
          : <TablePicker tables={tables} selected={selected} setSelected={setSelected} rules={rules} setRules={setRules} />}
        <div className="panel-footer options">
          <span>{selected.length} / {tables.length} sélectionnée{selected.length > 1 ? 's' : ''}</span>
          <Segmented label="Gestion des erreurs" value={mode} onChange={setMode} options={[
            { value: 'atomic', label: 'Tout ou rien', title: 'Au moindre échec, tout est annulé' },
            { value: 'continue', label: 'Continuer malgré les erreurs', title: 'Les tables en erreur sont ignorées et listées à la fin' },
          ]} />
          <label className="select-option">Tables existantes
            <select value={existing} onChange={(event) => setExisting(event.target.value)}>
              <option value="create">Erreur si elle existe</option>
              <option value="replace">Remplacer</option>
              <option value="append">Ajouter les lignes</option>
              <option value="upsert">Mettre à jour (clé primaire)</option>
            </select>
          </label>
          <label className="replace-toggle"><input type="checkbox" checked={verify} onChange={(event) => setVerify(event.target.checked)} /><span className="toggle" />Vérifier après transfert</label>
        </div>
      </section>

      <section className="action-bar">
        <div className={`status ${status.type}`}><span className="status-dot" />{status.text || 'Prêt à inspecter une source'}</div>
        <div className="actions">
          <button className="button button-outline" onClick={simulate} disabled={!selected.length || busy} title="Montre le SQL et les lignes concernées sans rien écrire">Simuler</button>
          <button className="button button-primary" onClick={transfer} disabled={!selected.length || busy}>Lancer le transfert <span>↗</span></button>
        </div>
      </section>

      <ProgressPanel job={job} onCancel={cancel} />
      <Report report={report} />

      <section className="workspace-panel files-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">04 · Fichiers</p><h2>Exporter ou importer</h2></div>
        </div>
        <div className="files-grid">
          <div>
            <p className="files-label">Exporter les tables cochées de la source (anonymisation appliquée)</p>
            <div className="files-row">
              <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} aria-label="Format d’export">
                <option value="json">JSON RelayDB (réimportable)</option>
                <option value="sql">Script SQL</option>
                <option value="csv">CSV (une table)</option>
              </select>
              {exportFormat === 'sql' && (
                <select value={sqlDialect} onChange={(event) => setSqlDialect(event.target.value)} aria-label="Moteur du script SQL">
                  <option value="postgres">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option><option value="mssql">SQL Server</option><option value="oracle">Oracle</option><option value="sqlite">SQLite</option>
                </select>
              )}
              <button className="button button-outline" onClick={exportData} disabled={!selected.length || busy}>Exporter</button>
            </div>
          </div>
          <div>
            <p className="files-label">Importer un export JSON RelayDB dans la base cible (mêmes options)</p>
            <div className="files-row">
              <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={importFile} />
              <button className="button button-outline" onClick={() => fileInput.current?.click()} disabled={!target || busy}>Choisir un fichier…</button>
            </div>
          </div>
        </div>
      </section>

      <HistoryPanel status={store} history={history} onReuse={reuseEntry} onShow={showEntry} onDelete={deleteEntry} onClear={clearHistory} onRefresh={refreshStore} />

      <footer>
        <span>{store.enabled ? 'Historique et profils chiffrés (AES-256-GCM) sur le serveur local.' : 'Rien n’est enregistré : historique désactivé.'}</span>
        <span>RelayDB · privé par défaut</span>
      </footer>
    </main>
  )
}

export default App
