import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { io as connectSocket } from 'socket.io-client'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const getAvailablePort = async () => {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const { port } = listener.address()
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return port
}

const connectAuthenticated = (baseUrl, cookie) => new Promise((resolve, reject) => {
  const socket = connectSocket(baseUrl, { extraHeaders: { Cookie: cookie }, transports: ['websocket'] })
  socket.once('connect', () => resolve(socket))
  socket.once('connect_error', reject)
})

const emitWithAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve)
})

const waitForSocketEvent = (socket, event) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), 5_000)
  socket.once(event, (payload) => {
    clearTimeout(timeout)
    resolve(payload)
  })
})

test('production server serves the app and isolates server membership behind invites', { timeout: 90_000 }, async (context) => {
  const tempRoot = await mkdtemp(join(projectRoot, '.reform-deployment-test-'))
  await mkdir(join(tempRoot, 'server'), { recursive: true })
  await cp(join(projectRoot, 'server', 'index.js'), join(tempRoot, 'server', 'index.js'))
  await cp(join(projectRoot, 'dist'), join(tempRoot, 'dist'), { recursive: true })

  const port = await getAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const backend = spawn(process.execPath, [join(tempRoot, 'server', 'index.js')], {
    cwd: tempRoot,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let backendOutput = ''
  backend.stdout.on('data', (chunk) => { backendOutput += chunk.toString() })
  backend.stderr.on('data', (chunk) => { backendOutput += chunk.toString() })
  context.after(async () => {
    if (backend.exitCode === null) backend.kill()
    if (!backend.closed) await once(backend, 'close')
    await rm(tempRoot, { recursive: true, force: true })
  })

  let isHealthy = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (backend.exitCode !== null) assert.fail(`Production server exited before becoming healthy: ${backendOutput}`)
    try {
      isHealthy = (await fetch(`${baseUrl}/api/health`)).ok
      if (isHealthy) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.equal(isHealthy, true, `Production server failed to start: ${backendOutput}`)

  const pageResponse = await fetch(baseUrl)
  assert.equal(pageResponse.status, 200)
  const html = await pageResponse.text()
  assert.match(html, /<title>REFORM<\/title>/)
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1]
  assert.ok(assetPath, 'The production HTML should reference a JavaScript asset.')
  assert.equal((await fetch(new URL(assetPath, baseUrl))).status, 200)

  const healthResponse = await fetch(`${baseUrl}/api/health`)
  assert.equal(healthResponse.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
  assert.ok(healthResponse.headers.get('content-security-policy'))
  assert.equal(healthResponse.headers.get('x-powered-by'), null)

  const register = async (username, email) => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        email,
        password: 'SecureTestPassword123!',
        passwordConfirmation: 'SecureTestPassword123!',
      }),
    })
    const result = await response.json()
    assert.equal(response.status, 201, JSON.stringify(result))
    assert.ok(result.account?.id)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/)
    return { cookie, account: result.account }
  }

  const owner = await register('Deploy Owner', 'deploy-owner@example.test')
  const ownerServers = await fetch(`${baseUrl}/api/servers`, { headers: { Cookie: owner.cookie } }).then((response) => response.json())
  assert.deepEqual(ownerServers, [])

  const createServerResponse = await fetch(`${baseUrl}/api/servers`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Private Deploy Guild' }),
  })
  const { server } = await createServerResponse.json()
  assert.equal(createServerResponse.status, 201)
  assert.ok(server?.id)
  assert.equal('inviteCode' in server, false)
  assert.equal('members' in server, false)

  const guest = await register('Deploy Guest', 'deploy-guest@example.test')
  const deniedHistory = await fetch(`${baseUrl}/api/servers/${server.id}/channels/welcome/messages`, {
    headers: { Cookie: guest.cookie },
  })
  assert.equal(deniedHistory.status, 404)

  const inviteResponse = await fetch(`${baseUrl}/api/servers/${server.id}/invites`, {
    method: 'POST',
    headers: { Cookie: owner.cookie },
  })
  const { inviteCode } = await inviteResponse.json()
  assert.equal(inviteResponse.status, 201)
  assert.ok(inviteCode)

  const joinResponse = await fetch(`${baseUrl}/api/server-invites/${encodeURIComponent(inviteCode)}`, {
    method: 'POST',
    headers: { Cookie: guest.cookie },
  })
  const joined = await joinResponse.json()
  assert.equal(joinResponse.status, 200)
  assert.equal(joined.joined, true)
  assert.equal(joined.server.id, server.id)

  const guestServers = await fetch(`${baseUrl}/api/servers`, { headers: { Cookie: guest.cookie } }).then((response) => response.json())
  assert.deepEqual(guestServers.map(({ id }) => id), [server.id])
  assert.equal((await fetch(`${baseUrl}/api/servers/${server.id}/channels/welcome/messages`, {
    headers: { Cookie: guest.cookie },
  })).status, 200)

  const ownerSocket = await connectAuthenticated(baseUrl, owner.cookie)
  const guestSocket = await connectAuthenticated(baseUrl, guest.cookie)
  context.after(() => {
    ownerSocket.disconnect()
    guestSocket.disconnect()
  })
  assert.deepEqual(await emitWithAck(ownerSocket, 'member:join', {}), { ok: true })
  assert.deepEqual(await emitWithAck(guestSocket, 'member:join', {}), { ok: true })
  const ownerDm = await emitWithAck(ownerSocket, 'dm:join', { contactId: guest.account.id })
  const guestDm = await emitWithAck(guestSocket, 'dm:join', { contactId: owner.account.id })
  assert.deepEqual(ownerDm, { ok: true })
  assert.deepEqual(guestDm, { ok: true })

  const incomingCall = waitForSocketEvent(guestSocket, 'dm-call:incoming')
  const startedCall = await emitWithAck(ownerSocket, 'dm-call:start', { toId: guest.account.id })
  assert.ok(startedCall.callId)
  assert.deepEqual(await incomingCall, {
    callId: startedCall.callId,
    fromId: owner.account.id,
    fromName: owner.account.username,
  })

  const callerAccepted = waitForSocketEvent(ownerSocket, 'dm-call:accepted')
  const calleeAccepted = waitForSocketEvent(guestSocket, 'dm-call:accepted')
  assert.deepEqual(await emitWithAck(guestSocket, 'dm-call:accept', { callId: startedCall.callId }), { ok: true })
  const callerConnection = await callerAccepted
  const calleeConnection = await calleeAccepted
  assert.equal(callerConnection.peerSocketId, guestSocket.id)
  assert.equal(calleeConnection.peerSocketId, ownerSocket.id)
  assert.deepEqual(await emitWithAck(ownerSocket, 'dm-call:start', { toId: guest.account.id }), {
    error: 'You are already in a direct call.',
  })

  const relayedSignal = waitForSocketEvent(guestSocket, 'dm-call:signal')
  ownerSocket.emit('dm-call:signal', {
    callId: startedCall.callId,
    to: guestSocket.id,
    description: { type: 'offer', sdp: 'test offer' },
  })
  assert.deepEqual(await relayedSignal, {
    callId: startedCall.callId,
    from: ownerSocket.id,
    description: { type: 'offer', sdp: 'test offer' },
  })

  const callEnded = waitForSocketEvent(guestSocket, 'dm-call:ended')
  ownerSocket.emit('dm-call:end', { callId: startedCall.callId })
  assert.deepEqual(await callEnded, { callId: startedCall.callId, reason: 'ended' })
  assert.ok(!(await emitWithAck(ownerSocket, 'dm-call:accept', { callId: startedCall.callId })).ok)
})
