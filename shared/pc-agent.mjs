import { validatedTool } from './tool-validation.mjs'

/** Discover the connected PC's real tools, independently of the model provider. */
export async function pcTools(fetcher, url, files, token, signal, trace, smallContext = () => false) {
  const response = await fetcher(`${url}/pc-tools`, { signal })
  // Older bridges remain usable for Android-only tasks.
  if (response.status === 404) return { tools: [], system: 'Ce PC ne fournit pas encore ses outils de fichiers : mettez à jour le serveur pour agir dessus.' }
  if (!response.ok) throw new Error(`Outils PC indisponibles (${response.status}).`)
  const manifest = await response.json()
  if (!Array.isArray(manifest.tools) || !Array.isArray(manifest.roots)) throw new Error('Capacités PC invalides.')
  const tools = manifest.tools.map(({ name, description, parameters }) => ({
    name: `pc_${name}`, description: `ON THE PC: ${description}`, parameters,
    async run(args, { signal } = {}) {
      signal?.throwIfAborted()
      const result = await fetcher(`${url}/pc-tools`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args, ...(smallContext() ? { compact: true } : {}), ...(trace ? { trace } : {}) }), signal,
      })
      const body = await result.json()
      if (!result.ok) throw new Error(body.error || `Action PC refusée (${result.status}).`)
      return body.result
    },
  }))
  tools.push({
    name: 'upload_to_pc',
    description: 'Copy an Android file to the PC inbox and return its PC path, for pc_* tools. The Android original is kept.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Android path' } }, required: ['path'] },
    async run({ path }, { signal } = {}) {
      signal?.throwIfAborted()
      const saved = await files.upload({ path, url, token: token() })
      signal?.throwIfAborted()
      if (typeof saved.path !== 'string' || !saved.path) throw new Error('Le PC n’a pas renvoyé le chemin du fichier reçu.')
      return JSON.stringify(saved)
    },
  })
  // Facts only: the schemas already name each tool, and every byte here is
  // taken from on-device Gemma's small window.
  // Plain paths, not JSON: a Windows backslash would otherwise be escaped twice
  // over once the prompt itself is serialised.
  const named = Object.entries(manifest.folders ?? {})
  const label = (path) => named.filter(([, folder]) => folder === path).map(([name]) => name).join(', ')
  const roots = manifest.roots.map((root) => label(root) ? `${root} (${label(root)})` : root)
  const others = named.filter(([, folder]) => !manifest.roots.includes(folder)).map(([name, folder]) => `${name} = ${folder}`)
  const facts = [
    `PC connecté (${manifest.platform}). Dossier utilisateur : ${manifest.home}. Dossiers PC autorisés : ${roots.join(' ; ')}.`,
    others.length ? `Dossiers PC connus : ${others.join(' ; ')}.` : '',
    `Écritures PC : ${manifest.allowWrites ? 'autorisées' : 'désactivées'}. pc_* agit sur le PC. upload_to_pc copie depuis Android et renvoie le chemin PC. show(image=chemin_PC) affiche sur le téléphone.`,
    manifest.tools.some((tool) => tool.name === 'run_command')
      ? `pc_run_command utilise le shell du compte PC (${manifest.platform === 'win32' ? 'PowerShell et .NET' : 'shell système'}), notamment pour capturer l’écran du PC.` : '',
  ].filter(Boolean)
  return { tools: tools.map(validatedTool), system: facts.join('\n') }
}
