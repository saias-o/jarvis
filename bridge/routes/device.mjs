/**
 * The device routes: the PC's tools and inference for the phone (/pc-tools,
 * /inference), health, uploads to the inbox and the local /auth answer.
 */
import { INFERENCE_MAX_BYTES } from '../../shared/remote-chat.mjs'
import { elevenKey } from './voice.mjs'
import { UNHANDLED } from './unhandled.mjs'

export function deviceRoutes({ TRACE, androidPcTools, inferAndroid, INBOX, BRAIN_MODE, CLAUDE_HEALTH, LOCAL }) {
  // At most two phone inferences at once; each holds a Claude process.
  let inferenceRequests = 0

  return async (req, res, cors) => {
    if (req.url === '/pc-tools') {
      const logger = TRACE.child({ requestId: crypto.randomUUID(), transport: 'pc-tools' })
      const started = Date.now()
      const json = (status, value) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET') return json(200, androidPcTools.manifest)
      if (req.method !== 'POST') return json(405, { error: 'GET or POST required' })
      const controller = new AbortController()
      const disconnected = () => { if (!res.writableEnded) controller.abort() }
      res.on('close', disconnected)
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 256 * 1024) return json(413, { error: 'PC tool request too large' })
          chunks.push(chunk)
        }
        let input
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(400, { error: 'Invalid JSON' }) }
        if (!input || typeof input !== 'object') return json(400, { error: 'Invalid PC tool request' })
        console.log(`[jarvis] PC tool: ${input.name}`)
        await logger.record('tool.start', { name: input.name, arguments: input.args, client: input.trace })
        const result = await androidPcTools.run(input, controller.signal)
        await logger.record('tool.result', { result, durationMs: Date.now() - started })
        if (!res.destroyed) return json(200, { result })
      } catch (err) {
        await logger.record('tool.error', { error: err, cancelled: controller.signal.aborted, durationMs: Date.now() - started })
        console.warn('[jarvis] PC tool refused:', err.message)
        if (!res.destroyed) return json(403, { error: err.message })
      } finally {
        res.off('close', disconnected)
      }
      return
    }

    if (req.url === '/inference') {
      const logger = TRACE.child({ requestId: crypto.randomUUID(), transport: 'inference' })
      const json = (status, value) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      if (req.method !== 'POST') return json(405, { error: 'POST required' })
      if (inferenceRequests >= 2) return json(429, { error: 'Inference busy' })
      inferenceRequests++
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120_000)
      const disconnected = () => { if (!res.writableEnded) controller.abort() }
      res.on('close', disconnected)
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > INFERENCE_MAX_BYTES) return json(413, { error: 'Inference request too large' })
          chunks.push(chunk)
        }
        let input
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(400, { error: 'Invalid JSON' }) }
        await logger.record('inference.start', { client: input.trace })
        console.log('[jarvis] Android inference tools:', input.tools?.map((tool) => tool.function?.name).join(', ') || '(none)')
        const last = input.messages?.at(-1)
        if (last?.role === 'tool' && /^(That failed:|There is no tool)/.test(last.content)) console.warn(`[jarvis] ${last.tool_name}: ${last.content}`)
        const result = await inferAndroid(input, controller.signal, (event, data) => logger.record(event, data))
        await logger.record('model.response', result)
        if (!res.destroyed) return json(200, result)
      } catch (err) {
        await logger.record('model.error', { error: err, cancelled: controller.signal.aborted })
        console.error('[jarvis] Android inference:', err.message)
        if (!res.destroyed) return json(err.message === 'Invalid inference request' ? 400 : 503, { error: 'Android inference unavailable' })
      } finally {
        clearTimeout(timeout)
        res.off('close', disconnected)
        inferenceRequests--
      }
      return
    }

    if (req.method === 'GET' && req.url === '/health') {
      // The browser reads this once at boot to decide which voice engine to use.
      // Both premium paths ride the same ElevenLabs key, so both flags track it:
      // with a key the app transcribes with Scribe and speaks with ElevenLabs;
      // without one it falls back to the browser's own recogniser and voice, so a
      // student with nothing configured still has a working assistant.
      const eleven = Boolean(elevenKey())
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          ok: true,
          inference: 'android-v1',
          tts: eleven,
          stt: eleven,
          // Which brain is answering, for the interface's readout.
          brain: {
            mode: BRAIN_MODE,
            claude: BRAIN_MODE !== 'local' && !CLAUDE_HEALTH.down(),
            local: (await LOCAL.available()) ? LOCAL.model : null,
          },
        }),
      )
    }

    // A file handed to JARVIS: the raw bytes as the body, the name in the query.
    // It lands in the inbox and the page is told where, so the next question can
    // name it. See inbox.mjs for what is and is not accepted.
    if (req.method === 'POST' && req.url?.startsWith('/upload')) {
      const name = new URL(req.url, 'http://x').searchParams.get('name') ?? ''
      try {
        const saved = await INBOX.receive(req, name)
        console.log(`[jarvis] file received: ${saved.name} (${saved.size} bytes)`)
        res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
        return res.end(JSON.stringify(saved))
      } catch (err) {
        // An upload refused part way still has a sender writing to the socket.
        req.resume()
        res.writeHead(err.status ?? 500, cors)
        return res.end(err.status ? err.message : 'the file could not be stored')
      }
    }

    // The interface asks this before anything else, wherever it was served from.
    // On this port there is no code to give; the remote port answers for itself.
    if (req.method === 'GET' && req.url === '/auth') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ required: false, ok: true }))
    }
    return UNHANDLED
  }
}
