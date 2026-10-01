import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const waitForServerReady = (child) =>
  new Promise((resolveReady, rejectReady) => {
    const timeoutId = setTimeout(() => {
      rejectReady(new Error('Timed out waiting for mock sync server startup.'))
    }, 10_000)

    const onData = (chunk) => {
      const text = chunk.toString()
      if (text.includes('Mock cloud sync server running at')) {
        clearTimeout(timeoutId)
        child.stdout.off('data', onData)
        resolveReady()
      }
    }

    child.stdout.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timeoutId)
      rejectReady(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeoutId)
      rejectReady(new Error(`Mock sync server exited early with code ${code}.`))
    })
  })

const stopServer = (child) =>
  new Promise((resolveStop) => {
    if (child.killed) {
      resolveStop()
      return
    }

    child.once('exit', () => resolveStop())
    child.kill()
  })

test('mock cloud sync server contract', async (t) => {
  const port = 8900 + Math.floor(Math.random() * 200)
  const token = 'contract-test-token'
  const profileId = 'qa_profile_001'
  const dataFile = join(
    tmpdir(),
    `chess-tips-sync-${Date.now()}-${Math.floor(Math.random() * 1000)}.json`,
  )

  const server = spawn('node', ['scripts/mock-cloud-sync-server.mjs'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      SYNC_PORT: String(port),
      CLOUD_SYNC_TOKEN: token,
      SYNC_DATA_FILE: dataFile,
      SYNC_ALLOWED_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  t.after(async () => {
    await stopServer(server)
    await rm(dataFile, { force: true })
  })

  await waitForServerReady(server)

  const baseUrl = `http://127.0.0.1:${port}`

  const unauthorizedGet = await fetch(`${baseUrl}/profiles/${profileId}`)
  assert.equal(unauthorizedGet.status, 401)

  const payload = {
    profileId,
    studyHistory: [
      {
        id: 'entry-1',
        timestamp: new Date().toISOString(),
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        sideToMove: 'w',
        moveInput: 'e4',
        moveSan: 'e4',
        quality: 'Best',
        scoreLabel: '+0.30',
        loss: 0,
        warning: null,
        comparison: 'Best line match.',
      },
    ],
    photoStudies: [],
  }

  const putResponse = await fetch(`${baseUrl}/profiles/${profileId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  assert.equal(putResponse.status, 200)
  const putJson = await putResponse.json()
  assert.equal(putJson.ok, true)
  assert.equal(putJson.profileId, profileId)
  assert.ok(Array.isArray(putJson.payload.studyHistory))
  assert.equal(putJson.payload.studyHistory.length, 1)
  assert.ok(typeof putJson.payload.updatedAt === 'string')

  const getResponse = await fetch(`${baseUrl}/profiles/${profileId}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  assert.equal(getResponse.status, 200)
  const getJson = await getResponse.json()
  assert.equal(getJson.ok, true)
  assert.equal(getJson.profileId, profileId)
  assert.equal(getJson.payload.studyHistory[0].moveSan, 'e4')

  const savedDataText = await readFile(dataFile, 'utf-8')
  const savedData = JSON.parse(savedDataText)
  assert.ok(savedData[profileId])
  assert.equal(savedData[profileId].studyHistory[0].moveInput, 'e4')
})
