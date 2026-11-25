import { useState } from 'react'
import { METHODS, suggestRule } from './anonymization.js'

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`
const formatDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })
const formatDuration = (ms) => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`

export function ConnectionCard({ step, title, accent, id, value, onChange, hint, profiles, storeEnabled, onPickProfile, onSaveProfile, onDeleteProfile }) {
  const [picked, setPicked] = useState('')
  return (
    <div className={`connection-card ${accent}`}>
      <div className="card-label"><span className="step">{step}</span><span>{title}</span><span className={`dot ${accent === 'source-card' ? 'online' : ''}`} /></div>
      <label htmlFor={id}>Chaîne de connexion</label>
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} spellCheck="false" autoComplete="off" />
      <p className="hint">{hint}</p>
      {storeEnabled && (
        <div className="profile-row">
          <select value={picked} onChange={(event) => { setPicked(event.target.value); if (event.target.value) onPickProfile(event.target.value) }} aria-label={`Profil enregistré pour ${title}`}>
            <option value="">Profils enregistrés…</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.display}</option>)}
          </select>
          <button type="button" className="link-button" onClick={onSaveProfile} disabled={!value}>Enregistrer</button>
          {picked && <button type="button" className="link-button danger" onClick={() => { onDeleteProfile(picked); setPicked('') }}>Supprimer</button>}
        </div>
      )}
    </div>
  )
}

export function TablePicker({ tables, selected, setSelected, rules, setRules }) {
  const [open, setOpen] = useState(null)
  const toggle = (name) => setSelected((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])
  const setRule = (table, column, method) => setRules((current) => {
    const next = { ...(current[table] || {}) }
    if (method) next[column] = method
    else delete next[column]
    return { ...current, [table]: next }
  })
  const suggest = () => setRules((current) => {
    const next = { ...current }
    for (const table of tables.filter((item) => selected.includes(item.name))) {
      const tableRules = { ...(next[table.name] || {}) }
      for (const column of table.columns) {
        const method = suggestRule(column)
        if (method && !tableRules[column.name]) tableRules[column.name] = method
      }
      next[table.name] = tableRules
    }
    return next
  })
  const ruleCount = Object.values(rules).reduce((sum, tableRules) => sum + Object.keys(tableRules).length, 0)

  return (
    <>
      <div className="picker-tools">
        <button type="button" className="link-button" onClick={() => setSelected(tables.map((table) => table.name))}>Tout cocher</button>
        <button type="button" className="link-button" onClick={() => setSelected([])}>Tout décocher</button>
        <span className="picker-spacer" />
        <span>{ruleCount ? `${plural(ruleCount, 'colonne')} anonymisée${ruleCount > 1 ? 's' : ''} ou exclue${ruleCount > 1 ? 's' : ''}` : 'Aucune anonymisation'}</span>
        <button type="button" className="link-button" onClick={suggest} title="Repère les colonnes au nom sensible (e-mail, téléphone, mot de passe, IP…) dans les tables cochées">Suggérer l’anonymisation</button>
        {ruleCount > 0 && <button type="button" className="link-button danger" onClick={() => setRules({})}>Tout copier tel quel</button>}
      </div>
      <div className="table-list">
        {tables.map((table) => {
          const tableRules = rules[table.name] || {}
          const count = Object.keys(tableRules).length
          return (
            <div className={`table-item ${open === table.name ? 'open' : ''}`} key={table.name}>
              <div className="table-row">
                <label className="table-check">
                  <input type="checkbox" checked={selected.includes(table.name)} onChange={() => toggle(table.name)} />
                  <span className="checkbox-mark">✓</span>
                  <span className="table-icon">▦</span>
                  <span className="table-name">{table.name}</span>
                </label>
                <span className="table-meta">{plural(table.rows, 'ligne')}</span>
                <button type="button" className="columns-toggle" onClick={() => setOpen(open === table.name ? null : table.name)} aria-expanded={open === table.name}>
                  {plural(table.columns.length, 'colonne')}{count > 0 && <span className="badge">{count}</span>} {open === table.name ? '▴' : '▾'}
                </button>
              </div>
              {open === table.name && (
                <ul className="column-list">
                  {table.columns.map((column) => (
                    <li key={column.name}>
                      <span className="column-name">{column.primary && <span title="Clé primaire">🔑 </span>}{column.name}</span>
                      <span className="column-type">{column.type}{column.length ? `(${column.length})` : ''}{column.nullable ? '' : ' · requis'}</span>
                      <select value={tableRules[column.name] || ''} onChange={(event) => setRule(table.name, column.name, event.target.value)} disabled={column.primary} aria-label={`Traitement de ${table.name}.${column.name}`}>
                        {METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

export function Segmented({ label, value, onChange, options }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? 'active' : ''} onClick={() => onChange(option.value)} title={option.title}>{option.label}</button>
      ))}
    </div>
  )
}

export function ProgressPanel({ job, onCancel }) {
  const progress = job?.progress
  if (!job || job.status !== 'running' || !progress) return null
  const percent = progress.rowsTotal ? Math.min(100, Math.round((progress.rowsDone / progress.rowsTotal) * 100)) : 0
  return (
    <section className="progress-panel" aria-live="polite">
      <div className="progress-head">
        <span>{progress.phase}{progress.table ? ` · ${progress.table}` : ''}</span>
        <span>{progress.rowsDone.toLocaleString('fr-FR')} / {progress.rowsTotal.toLocaleString('fr-FR')} lignes · {progress.tablesDone}/{progress.tablesTotal} tables</span>
      </div>
      <div className="progress-track"><div className="progress-bar" style={{ width: `${progress.phase === 'vérification' || progress.phase === 'contraintes' ? 100 : percent}%` }} /></div>
      <button type="button" className="button button-outline" onClick={onCancel} disabled={job.cancelRequested}>{job.cancelRequested ? 'Annulation…' : 'Annuler'}</button>
    </section>
  )
}

const icon = (status) => ({ ok: '✓', skipped: '–', mismatch: '≠' }[status] || '✕')

function ReportList({ title, items, render }) {
  if (!items?.length) return null
  return <><p className="report-title">{title}</p><ul>{items.map(render)}</ul></>
}

export function Report({ report }) {
  if (!report) return null
  return (
    <section className={`report ${report.ok ? 'report-ok' : 'report-error'}`}>
      {report.dryRun && <p className="report-title">Simulation : rien n’a été écrit dans la cible</p>}
      {report.error && <p className="report-title">{report.cancelled ? 'Transfert annulé' : 'Transfert annulé'} — {report.error}</p>}
      {report.cancelled && !report.error && <p className="report-title">Transfert interrompu à la demande</p>}
      <ReportList title="Tables" items={report.tables} render={(item) => (
        <li key={item.table} className={item.status}><span>{icon(item.status)} {item.table}{item.action ? ` · ${item.action}` : ''}</span><span>{item.status === 'ok' ? `${item.rows.toLocaleString('fr-FR')} ligne${item.rows > 1 ? 's' : ''}${report.dryRun ? ' à copier' : ''}` : item.error}</span></li>
      )} />
      <ReportList title="Vérification" items={report.verification} render={(item) => (
        <li key={item.table} className={item.status === 'mismatch' ? 'error' : item.status}><span>{icon(item.status)} {item.table}</span><span>{item.status === 'ok' ? `${item.actual}/${item.expected} lignes identiques` : item.error}</span></li>
      )} />
      <ReportList title="Index" items={report.indexes} render={(item) => (
        <li key={`${item.table}-${item.name}`} className={item.status}><span>{icon(item.status)} {item.table} ({item.columns.join(', ')}){item.unique ? ' · unique' : ''}</span><span>{item.status === 'ok' ? (report.dryRun ? 'à créer' : 'créé') : item.error}</span></li>
      )} />
      <ReportList title="Contraintes CHECK" items={report.checks} render={(item) => (
        <li key={`${item.table}-${item.name}`} className={item.status}><span>{icon(item.status)} {item.table} · {item.name}</span><span>{item.status === 'ok' ? (report.dryRun ? 'à créer' : 'créée') : item.error}</span></li>
      )} />
      <ReportList title="Clés étrangères" items={report.foreignKeys} render={(fk) => (
        <li key={`${fk.table}-${fk.name}`} className={fk.status}><span>{icon(fk.status)} {fk.table}.{fk.columns.join(', ')} → {fk.references}</span><span>{fk.status === 'ok' ? (report.dryRun ? 'à créer' : 'créée') : fk.error}</span></li>
      )} />
      <ReportList title="Avertissements" items={report.warnings} render={(warning, index) => <li key={index} className="warning"><span>! {warning}</span></li>} />
      {report.statements?.length > 0 && (
        <details className="statements" open={report.dryRun}>
          <summary>SQL qui serait exécuté ({report.statements.length} instructions)</summary>
          <pre>{report.statements.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}

const KIND_LABEL = { transfert: 'Transfert', simulation: 'Simulation', import: 'Import' }
const STATUS_LABEL = { ok: 'Réussi', error: 'Avec erreurs', failed: 'Échec' }

export function HistoryPanel({ status, history, onReuse, onShow, onDelete, onClear, onRefresh }) {
  return (
    <section className="workspace-panel history-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Historique · chiffré</p><h2>Ce qui a déjà été fait</h2></div>
        {status.enabled && <div className="heading-actions">
          <button className="button button-outline" onClick={onRefresh}>↻ Actualiser</button>
          {history.length > 0 && <button className="button button-outline danger" onClick={onClear}>Tout effacer</button>}
        </div>}
      </div>
      {!status.enabled ? <div className="empty-state"><span className="empty-icon">🔒</span><p>{status.reason || 'Historique indisponible.'}</p></div>
        : history.length === 0 ? <div className="empty-state"><span className="empty-icon">⌁</span><p>Aucun transfert enregistré pour l’instant.</p></div>
          : <ul className="history-list">{history.map((entry) => (
            <li key={entry.id} className={`history-item ${entry.status}`}>
              <div className="history-main">
                <span className="history-kind">{KIND_LABEL[entry.kind] || entry.kind} · {STATUS_LABEL[entry.status] || entry.status}</span>
                <span className="history-route">{entry.source} → {entry.target}</span>
                <span className="history-meta">
                  {formatDate(entry.date)} · {formatDuration(entry.durationMs)} · {plural(entry.options?.tables?.length || 0, 'table')}
                  {entry.summary ? ` · ${entry.summary.rows.toLocaleString('fr-FR')} lignes` : ''}
                  {entry.options?.anonymized ? ` · ${plural(entry.options.anonymized, 'colonne')} anonymisée${entry.options.anonymized > 1 ? 's' : ''}` : ''}
                  {entry.error ? ` · ${entry.error}` : ''}
                </span>
              </div>
              <div className="history-actions">
                <button className="link-button" onClick={() => onShow(entry.id)}>Rapport</button>
                {entry.kind !== 'import' && <button className="link-button" onClick={() => onReuse(entry.id)}>Réutiliser</button>}
                <button className="link-button danger" onClick={() => onDelete(entry.id)}>Supprimer</button>
              </div>
            </li>
          ))}</ul>}
    </section>
  )
}
