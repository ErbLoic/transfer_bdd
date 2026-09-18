import { useState } from 'react'
import './App.css'

function App() {
  const [source, setSource] = useState('mysql://utilisateur:motdepasse@localhost:3306/ma_bdd')
  const [target, setTarget] = useState('mysql://root:motdepasse@localhost:3306/ma_bdd_locale')
  const [tables, setTables] = useState([])
  const [selected, setSelected] = useState([])
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [status, setStatus] = useState({ type: 'idle', text: '' })
  const [result, setResult] = useState([])

  const api = async (path, body) => {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Une erreur est survenue.')
    return data
  }

  const inspectSource = async () => {
    setStatus({ type: 'loading', text: 'Connexion à la source...' }); setResult([])
    try {
      const data = await api('test', { connectionString: source })
      setTables(data.tables); setSelected(data.tables)
      setStatus({ type: 'success', text: `${data.tables.length} table${data.tables.length > 1 ? 's' : ''} trouvée${data.tables.length > 1 ? 's' : ''} · ${data.kind}` })
    } catch (error) { setStatus({ type: 'error', text: error.message }); setTables([]) }
  }

  const transfer = async () => {
    if (!selected.length) return
    setStatus({ type: 'loading', text: 'Transfert en cours...' }); setResult([])
    try {
      const data = await api('transfer', { source, target, tables: selected, replaceExisting })
      setResult(data.details); setStatus({ type: 'success', text: 'Transfert terminé avec succès.' })
    } catch (error) { setStatus({ type: 'error', text: error.message }) }
  }

  return (
    <main className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">↗</span><span>Relay<span className="brand-accent">DB</span></span></div><span className="version">LOCAL TOOL · v1.0</span></header><section className="intro"><p className="eyebrow">Migration workspace</p><h1>Déplacer une base,<br /><em>sans perdre le fil.</em></h1><p className="intro-copy">Connectez une source et une cible. Inspectez les tables, choisissez votre périmètre, puis lancez le transfert.</p></section><section className="connections"><div className="connection-card source-card"><div className="card-label"><span className="step">01</span><span>Base source</span><span className="dot online" /></div><label htmlFor="source">Chaîne de connexion</label><input id="source" value={source} onChange={(event) => setSource(event.target.value)} spellCheck="false" /><p className="hint">MySQL, MariaDB ou PostgreSQL · lecture seule recommandée</p></div><div className="transfer-arrow">→</div><div className="connection-card target-card"><div className="card-label"><span className="step">02</span><span>Base cible</span><span className="dot" /></div><label htmlFor="target">Chaîne de connexion</label><input id="target" value={target} onChange={(event) => setTarget(event.target.value)} spellCheck="false" /><p className="hint">Les tables seront créées si elles n’existent pas</p></div></section><section className="workspace-panel"><div className="panel-heading"><div><p className="eyebrow">03 · Sélection</p><h2>Que voulez-vous emporter ?</h2></div><button className="button button-outline" onClick={inspectSource} disabled={!source || status.type === 'loading'}>↻ Inspecter la source</button></div>{tables.length === 0 ? <div className="empty-state"><span className="empty-icon">⌁</span><p>Inspectez la source pour afficher ses tables.</p></div> : <div className="table-list">{tables.map((table) => <label className="table-row" key={table}><input type="checkbox" checked={selected.includes(table)} onChange={() => setSelected((current) => current.includes(table) ? current.filter((item) => item !== table) : [...current, table])} /><span className="checkbox-mark">✓</span><span className="table-icon">▦</span><span>{table}</span></label>)}</div>}<div className="panel-footer"><span>{selected.length} / {tables.length} sélectionnée{selected.length > 1 ? 's' : ''}</span><label className="replace-toggle"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} /><span className="toggle" />Remplacer les tables existantes</label></div></section><section className="action-bar"><div className={`status ${status.type}`}><span className="status-dot" />{status.text || 'Prêt à inspecter une source'}</div><button className="button button-primary" onClick={transfer} disabled={!selected.length || status.type === 'loading'}>Lancer le transfert <span>↗</span></button></section>{result.length > 0 && <section className="result-strip"><strong>Transfert confirmé</strong>{result.map((item) => <span key={item.table}>{item.table} · {item.rows} ligne{item.rows > 1 ? 's' : ''}</span>)}</section>}<footer><span>Les identifiants restent dans votre navigateur et ne sont jamais enregistrés.</span><span>RelayDB · privé par défaut</span></footer></main>
  )
}

export default App
