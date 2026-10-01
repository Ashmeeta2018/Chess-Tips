import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const PORT = Number(process.env.SYNC_PORT ?? 8787)
const TOKEN = process.env.CLOUD_SYNC_TOKEN ?? ''
const DATA_FILE = resolve(
  process.cwd(),
  process.env.SYNC_DATA_FILE ?? 'tmp/mock-sync-data.json',
)
const ALLOWED_ORIGIN = process.env.SYNC_ALLOWED_ORIGIN ?? '*'

const store = new Map()

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  })
  response.end(JSON.stringify(payload, null, 2))
}

const isAuthorized = (request) => {
  if (!TOKEN) {
    return true
  }

  const authHeader = request.headers.authorization ?? ''
  return authHeader === `Bearer ${TOKEN}`
}

const getProfileIdFromPath = (pathname) => {
  const match = pathname.match(/^\/profiles\/([^/]+)$/)
  if (!match) {
    return null
  }

  return decodeURIComponent(match[1])
}

const readJsonBody = async (request) => {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }

  const bodyText = Buffer.concat(chunks).toString('utf-8').trim()
  if (!bodyText) {
    return {}
  }

  return JSON.parse(bodyText)
}

const toPayload = (profileId, body) => ({
  profileId,
  studyHistory: Array.isArray(body.studyHistory) ? body.studyHistory : [],
  photoStudies: Array.isArray(body.photoStudies) ? body.photoStudies : [],
  updatedAt: new Date().toISOString(),
})

const saveStore = async () => {
  const folder = dirname(DATA_FILE)
  await mkdir(folder, { recursive: true })

  const serializable = Object.fromEntries(store.entries())
  await writeFile(DATA_FILE, JSON.stringify(serializable, null, 2), 'utf-8')
}

const loadStore = async () => {
  if (!existsSync(DATA_FILE)) {
    return
  }

  try {
    const raw = await readFile(DATA_FILE, 'utf-8')
    const parsed = JSON.parse(raw)

    for (const [profileId, payload] of Object.entries(parsed)) {
      store.set(profileId, payload)
    }
  } catch {
    // Corrupt files should not crash local development.
  }
}

await loadStore()

const server = createServer(async (request, response) => {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

  if (method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  if (url.pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'mock-cloud-sync' })
    return
  }

  const profileId = getProfileIdFromPath(url.pathname)
  if (!profileId) {
    sendJson(response, 404, {
      ok: false,
      message: 'Route not found. Use GET or PUT /profiles/:profileId',
    })
    return
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, {
      ok: false,
      message: 'Unauthorized. Provide Authorization: Bearer <token>.',
    })
    return
  }

  if (method === 'GET') {
    const existing = store.get(profileId)
    if (!existing) {
      sendJson(response, 404, {
        ok: false,
        message: `No sync payload stored for profile ${profileId}.`,
      })
      return
    }

    sendJson(response, 200, {
      ok: true,
      profileId,
      payload: existing,
    })
    return
  }

  if (method === 'PUT') {
    try {
      const body = await readJsonBody(request)
      const payload = toPayload(profileId, body)
      store.set(profileId, payload)
      await saveStore()

      sendJson(response, 200, {
        ok: true,
        profileId,
        payload,
      })
    } catch {
      sendJson(response, 400, {
        ok: false,
        message: 'Invalid JSON payload. Could not save profile sync data.',
      })
    }
    return
  }

  sendJson(response, 405, {
    ok: false,
    message: 'Method not allowed. Use GET or PUT on /profiles/:profileId.',
  })
})

server.listen(PORT, () => {
  console.log(`Mock cloud sync server running at http://localhost:${PORT}`)
  console.log(`Data file: ${DATA_FILE}`)
  if (TOKEN) {
    console.log('Auth required via Authorization: Bearer <CLOUD_SYNC_TOKEN>')
  } else {
    console.log('Auth disabled because CLOUD_SYNC_TOKEN is empty.')
  }
})
