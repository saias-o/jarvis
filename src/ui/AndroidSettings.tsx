import { useEffect, useState } from 'react'
import { isAndroid, JarvisFiles, JarvisLlm, JarvisModels } from '../lib/android'
import { readDeviceSettings, saveDeviceSettings, pcAddress } from '../lib/deviceSettings'
import { selectBridge } from '../config'
import { submitCode } from '../lib/access'
import './android-settings.css'

export function AndroidSettings() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(readDeviceSettings)
  const [pcs, setPcs] = useState(settings.pcs.join('\n'))
  const [code, setCode] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [granted, setGranted] = useState(false)

  useEffect(() => {
    if (!isAndroid) return
    let stopped = false
    const refresh = () => {
      void JarvisModels.status().then((s) => { if (!stopped) { setModel(s.path); setBusy(s.downloading) } })
      void JarvisFiles.status().then((s) => { if (!stopped) setGranted(s.granted) })
    }
    refresh()
    window.addEventListener('focus', refresh)
    const listener = JarvisModels.addListener('progress', (e) => {
      if (!stopped && e.total > 0) setProgress(Math.min(100, e.received / e.total * 100))
    })
    return () => { stopped = true; window.removeEventListener('focus', refresh); void listener.then((l) => l.remove()) }
  }, [])

  if (!isAndroid) return null

  const run = async (action: () => Promise<void>) => {
    setStatus(''); setBusy(true)
    try { await action() }
    catch (e) { setStatus(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return <>
    <button className="android-settings-toggle" onClick={() => setOpen(true)}>Réglages Android</button>
    {open && <div className="android-settings-backdrop">
      <section className="android-settings" role="dialog" aria-modal="true" aria-labelledby="android-title">
        <button className="android-settings-close" onClick={() => setOpen(false)} aria-label="Fermer">×</button>
        <h2 id="android-title">JARVIS sur ce téléphone</h2>
        <label>Cerveau
          <select value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value as typeof settings.mode })}>
            <option value="auto">Automatique : PC disponible, sinon téléphone</option>
            <option value="pc">PC distant</option>
            <option value="device">Gemma sur le téléphone</option>
          </select>
        </label>
        <label>Adresses HTTPS des PC Tailscale, une par ligne
          <textarea value={pcs} onChange={(e) => setPcs(e.target.value)} placeholder="https://pc.nom.ts.net" rows={3} />
        </label>
        <label>Calcul du modèle local
          <select value={settings.backend} onChange={(e) => setSettings({ ...settings, backend: e.target.value as 'cpu' | 'gpu' })}>
            <option value="gpu">GPU, avec repli CPU</option><option value="cpu">CPU</option>
          </select>
        </label>
        <button disabled={busy} onClick={() => void run(async () => {
          saveDeviceSettings({ ...settings, pcs: pcs.split('\n').map((s) => s.trim()).filter(Boolean) })
          window.location.reload()
        })}>Enregistrer et reconnecter</button>
        <h3>Modèle Gemma</h3>
        <p>{model ? 'Modèle présent sur le téléphone.' : 'Téléchargez le modèle une seule fois (~2,6 Go), ou importez un fichier .litertlm.'}</p>
        <label className="android-checkbox"><input type="checkbox" checked={settings.wifiOnly} onChange={(e) => setSettings({ ...settings, wifiOnly: e.target.checked })} />Télécharger uniquement sur Wi-Fi non facturé</label>
        {progress !== null && <progress aria-label="Téléchargement du modèle" max={100} value={progress} />}
        <div className="android-actions">
          <button disabled={busy} onClick={() => void run(async () => {
            await JarvisLlm.unload()
            const result = await JarvisModels.download({ wifiOnly: settings.wifiOnly })
            setModel(result.path); setStatus('Modèle prêt. Vous pouvez parler à JARVIS.')
          })}>Télécharger / reprendre</button>
          <button disabled={busy} onClick={() => void run(async () => {
            await JarvisLlm.unload()
            setModel((await JarvisModels.importModel()).path); setStatus('Modèle importé.')
          })}>Importer</button>
          {busy && <button onClick={() => void JarvisModels.cancel()}>Pause</button>}
        </div>
        <h3>Fichiers Android</h3>
        <p>{granted ? 'Accès au stockage accordé.' : 'Autorisez le stockage partagé pour que JARVIS puisse ranger vos fichiers.'}</p>
        <button onClick={() => void run(async () => { await JarvisFiles.requestAccess() })}>Autoriser les fichiers</button>
        <h3>Code du PC, s’il est activé</h3>
        <label>Code d’accès<input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" placeholder="XXXX-XXXX" /></label>
        <button disabled={busy || !code.trim()} onClick={() => void run(async () => {
          const pc = pcAddress(pcs.split('\n')[0])
          selectBridge(pc)
          const verdict = await submitCode(code)
          setCode('')
          setStatus(verdict === 'ok' ? 'PC associé pour cette session.' : `Association refusée : ${verdict}`)
        })}>Associer le PC</button>
        <p role="status" aria-live="polite">{status}</p>
      </section>
    </div>}
  </>
}
