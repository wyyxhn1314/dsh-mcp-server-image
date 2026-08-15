#!/usr/bin/env node
/**
 * dsh-mcp-server-image — a generic OpenAI-compatible image-generation MCP
 * server (stdio) for DeepSeek Harness / any MCP client.
 *
 * Wraps any `POST {baseURL}/images/generations` endpoint (OpenAI Images API
 * shape: gpt-image-*, dall-e-*, or any compatible relay/gateway) as one MCP
 * tool: `generate_image`.
 *
 * - API key: read from the environment variable named by `--key-env`
 *   (default IMAGE_API_KEY). Never embedded in config files.
 * - Proxy: standard Node env-proxy support. If your network needs a proxy,
 *   run with NODE_USE_ENV_PROXY=1 and set HTTPS_PROXY/ALL_PROXY (see README).
 * - Response handling: requests `response_format: "url"`; falls back to
 *   inline b64_json when the endpoint does not support url responses.
 * - Durability: optionally downloads/decodes images into `--out-dir`
 *   (default $DSH_HOME/generated, else ./generated).
 *
 * Zero dependencies: plain Node (global fetch) + JSON-RPC 2.0 over stdio.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_DEFAULT = 'https://api.openai.com/v1'
const MODEL_DEFAULT = 'gpt-image-1'
const KEY_ENV_DEFAULT = 'IMAGE_API_KEY'
const SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', 'auto']

// ---- tiny argv parser ------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    baseUrl: BASE_DEFAULT,
    model: MODEL_DEFAULT,
    keyEnv: KEY_ENV_DEFAULT,
    outDir: undefined,
    save: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--base-url': opts.baseUrl = next(); break
      case '--model': opts.model = next(); break
      case '--key-env': opts.keyEnv = next(); break
      case '--out-dir': opts.outDir = next(); break
      case '--no-save': opts.save = false; break
      case '--help':
      case '-h':
        console.log(
          'Usage: dsh-mcp-server-image [--base-url URL] [--model ID] [--key-env VAR] [--out-dir DIR] [--no-save]\n' +
          '  --base-url   OpenAI-compatible base URL (default ' + BASE_DEFAULT + ')\n' +
          '  --model      image model id (default ' + MODEL_DEFAULT + ')\n' +
          '  --key-env    env var holding the API key (default ' + KEY_ENV_DEFAULT + ')\n' +
          '  --out-dir    durable output dir (default $DSH_HOME/generated or ./generated)\n' +
          '  --no-save    do not download durable local copies',
        )
        process.exit(0)
        break
      default:
        process.stderr.write(`[dsh-mcp-server-image] unknown option: ${arg}\n`)
        process.exit(2)
    }
  }
  return opts
}

const OPT = parseArgs(process.argv.slice(2))

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

// ---- image generation ------------------------------------------------------
async function generateImage({ prompt, size = '1024x1024', n = 1, save }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('prompt is required and must be a non-empty string')
  }
  if (!SIZES.includes(size)) {
    throw new Error(`size must be one of: ${SIZES.join(', ')}`)
  }
  const count = Math.min(Math.max(1, Math.floor(n) || 1), 4)
  const key = process.env[OPT.keyEnv]
  if (!key) {
    throw new Error(`missing API key: set ${OPT.keyEnv} (env) or --key-env`)
  }
  const url = `${OPT.baseUrl.replace(/\/$/, '')}/images/generations`
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const body = { model: OPT.model, prompt: prompt.trim(), size, n: count, response_format: 'url' }

  let res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  // Some gateways reject response_format entirely; retry without it once.
  if (res.status === 400) {
    delete body.response_format
    res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`relay error HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const entries = (json.data ?? []).filter((d) => d !== null && typeof d === 'object')
  if (entries.length === 0) throw new Error('endpoint returned no image data')

  const imageUrls = []
  const savedFiles = []
  const saveEnabled = save === undefined ? OPT.save : save
  if (saveEnabled) {
    const dir = OPT.outDir ?? join(dshHome(), 'generated')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      let buf
      let ext = 'png'
      if (typeof entry.b64_json === 'string') {
        buf = Buffer.from(entry.b64_json, 'base64')
        const mt = entry.mime_type ?? ''
        if (mt.includes('jpeg')) ext = 'jpg'
        else if (mt.includes('webp')) ext = 'webp'
      } else if (typeof entry.url === 'string') {
        const img = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) })
        if (!img.ok) continue
        const ct = img.headers.get('content-type') ?? ''
        if (ct.includes('jpeg')) ext = 'jpg'
        else if (ct.includes('webp')) ext = 'webp'
        buf = Buffer.from(await img.arrayBuffer())
      } else {
        continue
      }
      const file = join(dir, `image-${Date.now()}-${i + 1}.${ext}`)
      writeFileSync(file, buf)
      savedFiles.push(file)
    }
  }
  for (const entry of entries) {
    if (typeof entry.url === 'string') imageUrls.push(entry.url)
  }

  return {
    imageUrls,
    size,
    count: entries.length,
    savedFiles,
    note: 'Presigned urls may expire (check with the provider); savedFiles are durable local copies.',
  }
}

// ---- MCP stdio transport (JSON-RPC 2.0, newline-delimited) -----------------
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line === '') continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg)
  }
})

async function handle(msg) {
  const { id, method, params } = msg
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-mcp-server-image', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: 'generate_image',
          description:
            `Generate an image via the ${OPT.model} model (OpenAI-compatible images API at ${OPT.baseUrl}). ` +
            'Returns https image URLs (show in chat with ![alt](url)) and saves durable local copies.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Detailed prompt describing the image to generate.' },
              size: { type: 'string', enum: SIZES, default: '1024x1024', description: 'Output size.' },
              n: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: 'Number of images.' },
              save: { type: 'boolean', default: true, description: 'Also save durable local copies.' },
            },
            required: ['prompt'],
          },
        }],
      },
    })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name !== 'generate_image') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(name)}` } })
      return
    }
    try {
      const result = await generateImage(args)
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      })
    } catch (err) {
      send({
        jsonrpc: '2.0', id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `generate_image failed: ${err instanceof Error ? err.message : String(err)}` }],
        },
      })
    }
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } })
  }
}

// boot diagnostics (stderr only; must not corrupt the stdio JSON channel)
if (!process.env[OPT.keyEnv]) {
  console.error(`[dsh-mcp-server-image] boot check: ${OPT.keyEnv} not set`)
}
if (process.env.NODE_USE_ENV_PROXY !== '1' && !(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)) {
  console.error('[dsh-mcp-server-image] boot check: no proxy configured (set NODE_USE_ENV_PROXY=1 + HTTPS_PROXY/ALL_PROXY if your network needs one)')
}
