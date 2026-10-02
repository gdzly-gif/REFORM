import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

const root = dirname(fileURLToPath(import.meta.url))
const frontendBuildDirectory = join(root, '..', 'dist')
const dataDirectory = join(root, '..', 'data')
const messagesPath = join(dataDirectory, 'messages.json')
const channelsPath = join(dataDirectory, 'channels.json')
const serversPath = join(dataDirectory, 'servers.json')
const profilePicturesPath = join(dataDirectory, 'profile-pictures.json')
const directMessagesPath = join(dataDirectory, 'direct-messages.json')
const accountsPath = join(dataDirectory, 'accounts.json')
const friendsPath = join(dataDirectory, 'friends.json')
const profilePictureDirectory = join(dataDirectory, 'profile-pictures')
const attachmentDirectory = join(dataDirectory, 'attachments')
const defaultServerId = 'reform'
const defaultTextChannels = [
  { label: 'welcome', topic: 'Welcome to the community.' },
  { label: 'lobby', topic: 'Find your squad. Share your wins.' },
  { label: 'looking-for-group', topic: 'Find teammates for your next run.' },
  { label: 'game-clips', topic: 'Post your best plays and moments.' },
  { label: 'strategy-lab', topic: 'Build theory, share the tech.' },
]
const defaultVoiceChannels = [{ label: 'Moonbase' }, { label: 'Boss Rush' }]
const defaultServer = { id: defaultServerId, name: 'REFORM', textChannels: defaultTextChannels, voiceChannels: defaultVoiceChannels }
let servers = [defaultServer]
const messageLimit = 1000
const attachmentLimit = 4
const maxAttachmentSize = 5 * 1024 * 1024
const rasterImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const attachmentTypes = new Set([...rasterImageTypes, 'application/pdf', 'text/plain', 'application/octet-stream'])
const allowedReactions = new Set(['😀', '😂', '🥹', '😍', '😎', '🤔', '😭', '😡', '👍', '👎', '👏', '🙌', '🔥', '❤️', '💯', '🎮', '🏆', '✨', '👀', '💀'])
const authRequestCounts = new Map()
const authRequestLimit = 10
const authRequestWindowMs = 15 * 60_000
const sessionLifetimeMs = 30 * 24 * 60 * 60_000
const sessionCookieName = 'reform_session'
const hashPassword = promisify(scrypt)
let accounts = []
const sessions = new Map()
let friendships = {}

await mkdir(dataDirectory, { recursive: true })
await mkdir(attachmentDirectory, { recursive: true })
await mkdir(profilePictureDirectory, { recursive: true })

try {
  const storedAccounts = JSON.parse(await readFile(accountsPath, 'utf8'))
  if (!Array.isArray(storedAccounts) || storedAccounts.some((account) =>
    !account || typeof account.id !== 'string' || typeof account.email !== 'string'
    || typeof account.displayName !== 'string' || typeof account.passwordHash !== 'string'
    || !/^[a-f0-9]{128}$/.test(account.passwordHash) || typeof account.passwordSalt !== 'string'
    || !/^[a-f0-9]{32}$/.test(account.passwordSalt))) {
    throw new Error('Stored accounts are invalid.')
  }
  accounts = storedAccounts
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(accountsPath, '[]\n', 'utf8')
}

try {
  const storedFriendships = JSON.parse(await readFile(friendsPath, 'utf8'))
  if (!storedFriendships || typeof storedFriendships !== 'object' || Array.isArray(storedFriendships)
    || Object.entries(storedFriendships).some(([accountId, friendIds]) =>
      !/^[\w-]{1,80}$/.test(accountId) || !Array.isArray(friendIds)
      || friendIds.some((friendId) => typeof friendId !== 'string' || !/^[\w-]{1,80}$/.test(friendId)))) {
    throw new Error('Stored friendships are invalid.')
  }
  friendships = storedFriendships
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(friendsPath, '{}\n', 'utf8')
}

let persistAccountsQueue = Promise.resolve()
const persistAccounts = () => {
  const currentWrite = persistAccountsQueue.then(() => writeFile(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8'))
  persistAccountsQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}

let persistFriendshipsQueue = Promise.resolve()
const persistFriendships = () => {
  const currentWrite = persistFriendshipsQueue.then(() => writeFile(friendsPath, `${JSON.stringify(friendships, null, 2)}\n`, 'utf8'))
  persistFriendshipsQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}
const getFriendIds = (accountId) => friendships[accountId] ?? []
const isFriend = (accountId, friendId) => getFriendIds(accountId).includes(friendId)
const getFriendProfile = (accountId) => {
  const account = accounts.find((item) => item.id === accountId)
  if (!account) return null
  const onlineMember = [...onlineMembers.values()].find((member) => member.id === accountId)
  const avatarUrl = profilePictures[accountId] ? `/api/profile-pictures/${encodeURIComponent(accountId)}` : undefined
  return { id: account.id, name: account.displayName, online: Boolean(onlineMember), ...(avatarUrl ? { avatarUrl } : {}) }
}

const publicAccount = ({ id, email, displayName }) => ({ id, email, username: displayName })
const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : ''
const isValidEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
const isValidAccountName = (name) => typeof name === 'string'
  && name.length >= 1 && name.length <= 32
  && /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)
const isStrongPassword = (password) => typeof password === 'string'
  && password.length >= 12 && password.length <= 128
  && /[a-z]/.test(password) && /[A-Z]/.test(password)
  && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
const hashSessionToken = (token) => createHash('sha256').update(token).digest('hex')
const getSessionToken = (cookieHeader = '') => cookieHeader.split(';')
  .map((part) => part.trim())
  .find((part) => part.startsWith(`${sessionCookieName}=`))
  ?.slice(sessionCookieName.length + 1) ?? ''
const getSessionAccount = (token) => {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const tokenHash = hashSessionToken(token)
  const session = sessions.get(tokenHash)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash)
    return null
  }
  return accounts.find((account) => account.id === session.accountId) ?? null
}
const setSessionCookie = (response, token) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.set('Set-Cookie', `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeMs / 1000}${secure}`)
}
const clearSessionCookie = (response) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.set('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`)
}
const allowAuthRequest = (request) => {
  const now = Date.now()
  const clientKey = request.ip ?? request.socket.remoteAddress ?? 'unknown'
  for (const [key, entry] of authRequestCounts) {
    if (now - entry.windowStartedAt >= authRequestWindowMs) authRequestCounts.delete(key)
  }
  let entry = authRequestCounts.get(clientKey)
  if (!entry || now - entry.windowStartedAt >= authRequestWindowMs) {
    entry = { windowStartedAt: now, count: 0 }
    authRequestCounts.set(clientKey, entry)
  }
  entry.count += 1
  return entry.count <= authRequestLimit
}
let accountRegistrationQueue = Promise.resolve()

const readLegacyChannels = async () => {
  try {
    const storedChannels = JSON.parse(await readFile(channelsPath, 'utf8'))
    if (!Array.isArray(storedChannels.textChannels) || !Array.isArray(storedChannels.voiceChannels)) {
      throw new Error('Stored channels must contain textChannels and voiceChannels arrays.')
    }
    for (const channel of storedChannels.textChannels) {
      if (!channel || typeof channel.label !== 'string' || typeof channel.topic !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(channel.label)) {
        throw new Error('Stored text channel is invalid.')
      }
      if (!defaultServer.textChannels.some((item) => item.label === channel.label)) {
        defaultServer.textChannels.push({ label: channel.label, topic: channel.topic.slice(0, 120) })
      }
    }
    for (const channel of storedChannels.voiceChannels) {
      if (!channel || typeof channel.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(channel.label)) {
        throw new Error('Stored voice channel is invalid.')
      }
      if (!defaultServer.voiceChannels.some((item) => item.label.toLowerCase() === channel.label.toLowerCase())) {
        defaultServer.voiceChannels.push({ label: channel.label })
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

try {
  const storedServers = JSON.parse(await readFile(serversPath, 'utf8'))
  if (!Array.isArray(storedServers) || storedServers.length === 0) throw new Error('Stored servers must be a non-empty array.')
  servers = storedServers
  if (!servers.some(({ id }) => id === defaultServerId)) {
    servers.unshift(defaultServer)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await readLegacyChannels()
  servers = [defaultServer]
  await writeFile(serversPath, `${JSON.stringify(servers, null, 2)}\n`, 'utf8')
}

let serversNeedMembershipMigration = false
for (const server of servers) {
  if (!server || typeof server.id !== 'string' || !/^[\w-]{1,80}$/.test(server.id)
    || typeof server.name !== 'string' || !server.name.trim() || !Array.isArray(server.textChannels)
    || !Array.isArray(server.voiceChannels)) {
    throw new Error('Stored server is invalid.')
  }
  if (!Array.isArray(server.members)) {
    server.members = accounts.map(({ id }) => id)
    serversNeedMembershipMigration = true
  }
  if (!server.ownerId) {
    server.ownerId = server.members[0] ?? null
    serversNeedMembershipMigration = true
  }
  if (!server.inviteCode) {
    server.inviteCode = randomBytes(9).toString('base64url')
    serversNeedMembershipMigration = true
  }
  if (!server.textChannels.some(({ label }) => label === 'welcome')) {
    server.textChannels.unshift({ label: 'welcome', topic: 'Welcome to the community.' })
    serversNeedMembershipMigration = true
  }
}
if (serversNeedMembershipMigration) {
  await writeFile(serversPath, `${JSON.stringify(servers, null, 2)}\n`, 'utf8')
}

let messages = []
let messagesNeedMigration = false
try {
  const storedMessages = JSON.parse(await readFile(messagesPath, 'utf8'))
  if (Array.isArray(storedMessages)) {
    messagesNeedMigration = storedMessages.some((message) => typeof message.serverId !== 'string')
    messages = storedMessages.map((message) => ({ ...message, serverId: message.serverId ?? defaultServerId }))
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(messagesPath, '[]\n', 'utf8')
}

let persistQueue = Promise.resolve()
const persistMessages = () => {
  const currentWrite = persistQueue.then(() => writeFile(messagesPath, `${JSON.stringify(messages, null, 2)}\n`, 'utf8'))
  persistQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}
if (messagesNeedMigration) await persistMessages()

let profilePictures = {}
try {
  const storedProfilePictures = JSON.parse(await readFile(profilePicturesPath, 'utf8'))
  if (!storedProfilePictures || typeof storedProfilePictures !== 'object' || Array.isArray(storedProfilePictures)) {
    throw new Error('Stored profile pictures must be an object.')
  }
  profilePictures = Object.fromEntries(Object.entries(storedProfilePictures).filter(([profileId, mimeType]) =>
    /^[\w-]{1,80}$/.test(profileId) && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(profilePicturesPath, '{}\n', 'utf8')
}

let directConversations = []
try {
  const storedConversations = JSON.parse(await readFile(directMessagesPath, 'utf8'))
  if (!Array.isArray(storedConversations)) throw new Error('Stored direct conversations must be an array.')
  directConversations = storedConversations
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(directMessagesPath, '[]\n', 'utf8')
}

let persistChannelsQueue = Promise.resolve()
const persistChannels = () => {
  const currentWrite = persistChannelsQueue.then(() => writeFile(serversPath, `${JSON.stringify(servers, null, 2)}\n`, 'utf8'))
  persistChannelsQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}
let persistProfilePicturesQueue = Promise.resolve()
const persistProfilePictures = () => {
  const currentWrite = persistProfilePicturesQueue.then(() => writeFile(profilePicturesPath, `${JSON.stringify(profilePictures, null, 2)}\n`, 'utf8'))
  persistProfilePicturesQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}
let persistDirectMessagesQueue = Promise.resolve()
const persistDirectMessages = () => {
  const currentWrite = persistDirectMessagesQueue.then(() => writeFile(directMessagesPath, `${JSON.stringify(directConversations, null, 2)}\n`, 'utf8'))
  persistDirectMessagesQueue = currentWrite.then(() => undefined, () => undefined)
  return currentWrite
}

const getServer = (serverId) => servers.find((server) => server.id === serverId)
const getChannelLists = (server) => ({ serverId: server.id, textChannels: server.textChannels, voiceChannels: server.voiceChannels })
const isServerMember = (server, accountId) => Boolean(server?.members?.includes(accountId))
const publicServer = ({ id, name, ownerId, textChannels, voiceChannels }) => ({ id, name, ownerId, textChannels, voiceChannels })
const getMemberServers = (accountId) => servers.filter((server) => isServerMember(server, accountId)).map(publicServer)
const isChatChannel = (server, channel) => typeof channel === 'string'
  && (server.textChannels.some((item) => item.label === channel)
    || (channel.startsWith('voice:') && server.voiceChannels.some((item) => item.label === channel.slice('voice:'.length))))
const textRoom = (serverId, channel) => `text:${serverId}:${channel}`
const voiceRoom = (serverId, channel) => `voice:${serverId}:${channel}`
const voiceRoomKey = (serverId, channel) => `${serverId}:${channel}`
const normalizeDmName = (name) => typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
const dmRoom = (firstId, secondId) => `dm:${[firstId, secondId].sort().join(':')}`
const isValidDmUserId = (userId) => typeof userId === 'string' && /^[\w-]{1,80}$/.test(userId)
const isValidDmName = (name) => typeof name === 'string' && name.length >= 1 && name.length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)
const getDmConversation = (firstId, secondId) => directConversations.find((conversation) =>
  conversation.participants.some((participant) => participant.id === firstId)
  && conversation.participants.some((participant) => participant.id === secondId))
const getDmStreak = (conversation, now = new Date()) => {
  const today = now.toISOString().slice(0, 10)
  const activityByDay = new Map()
  for (const message of conversation?.messages ?? []) {
    const day = message.createdAt.slice(0, 10)
    if (!activityByDay.has(day)) activityByDay.set(day, new Set())
    activityByDay.get(day).add(message.fromId)
  }
  const participantIds = conversation?.participants.map(({ id }) => id) ?? []
  const sharedDays = new Set([...activityByDay.entries()]
    .filter(([, participants]) => participantIds.every((id) => participants.has(id)))
    .map(([day]) => day))
  let cursor = new Date(`${today}T00:00:00.000Z`)
  if (!sharedDays.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1)
  let streak = 0
  while (sharedDays.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return { streak, activeToday: sharedDays.has(today), lastSharedDay: streak ? new Date(cursor.getTime() + 86_400_000).toISOString().slice(0, 10) : null }
}

const app = express()
app.disable('x-powered-by')
const trustedProxyHops = process.env.TRUST_PROXY
if (trustedProxyHops !== undefined) {
  if (!/^\d+$/.test(trustedProxyHops)) throw new Error('TRUST_PROXY must be a non-negative integer hop count.')
  app.set('trust proxy', Number(trustedProxyHops))
}
app.use((_request, response, next) => {
  response.set('X-Content-Type-Options', 'nosniff')
  response.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.set('X-Frame-Options', 'DENY')
  response.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)')
  if (process.env.NODE_ENV === 'production') {
    response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    response.set('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:")
  }
  next()
})
app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))
app.get('/api/auth/me', (request, response) => {
  const account = getSessionAccount(getSessionToken(request.headers.cookie))
  response.set('Cache-Control', 'no-store')
  if (!account) return response.status(401).json({ error: 'Sign in to continue.' })
  return response.json({ account: publicAccount(account) })
})
app.post('/api/auth/register', express.json({ limit: '10kb' }), async (request, response) => {
  response.set('Cache-Control', 'no-store')
  if (!allowAuthRequest(request)) return response.status(429).json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' })

  const email = normalizeEmail(request.body?.email)
  const password = request.body?.password
  const confirmation = request.body?.passwordConfirmation
  const displayName = typeof request.body?.username === 'string' ? request.body.username.trim().replace(/\s+/g, ' ') : ''
  if (!isValidEmail(email) || !isValidAccountName(displayName) || !isStrongPassword(password) || password !== confirmation) {
    return response.status(400).json({ error: 'Enter a valid username and email, matching passwords, and a strong password with at least 12 characters, uppercase and lowercase letters, a number, and a symbol.' })
  }

  const registration = accountRegistrationQueue.then(async () => {
    if (accounts.some((account) => account.email === email || account.displayName.toLowerCase() === displayName.toLowerCase())) return null
    const passwordSalt = randomBytes(16).toString('hex')
    const passwordHash = (await hashPassword(password, passwordSalt, 64)).toString('hex')
    const account = { id: randomUUID(), email, displayName, passwordSalt, passwordHash }
    accounts.push(account)
    try {
      await persistAccounts()
    } catch (error) {
      accounts = accounts.filter((item) => item.id !== account.id)
      console.error('Failed to save account:', error)
      throw error
    }
    return account
  })
  accountRegistrationQueue = registration.then(() => undefined, () => undefined)

  try {
    const account = await registration
    if (!account) return response.status(409).json({ error: 'That email or username is already in use.' })
    const token = randomBytes(32).toString('hex')
    sessions.set(hashSessionToken(token), { accountId: account.id, expiresAt: Date.now() + sessionLifetimeMs })
    setSessionCookie(response, token)
    return response.status(201).json({ account: publicAccount(account) })
  } catch {
    return response.status(500).json({ error: 'Your account could not be created. Please try again.' })
  }
})
app.post('/api/auth/login', express.json({ limit: '10kb' }), async (request, response) => {
  response.set('Cache-Control', 'no-store')
  if (!allowAuthRequest(request)) return response.status(429).json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' })

  const email = normalizeEmail(request.body?.email)
  const password = request.body?.password
  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 1 || password.length > 128) {
    return response.status(400).json({ error: 'Enter a valid email and password.' })
  }
  const account = accounts.find((item) => item.email === email)
  const expectedHash = account ? Buffer.from(account.passwordHash, 'hex') : Buffer.alloc(64)
  const suppliedHash = await hashPassword(password, account?.passwordSalt ?? randomBytes(16).toString('hex'), 64)
  const passwordMatches = expectedHash.length === suppliedHash.length && timingSafeEqual(expectedHash, suppliedHash)
  if (!account || !passwordMatches) return response.status(401).json({ error: 'The email or password is incorrect.' })

  const token = randomBytes(32).toString('hex')
  sessions.set(hashSessionToken(token), { accountId: account.id, expiresAt: Date.now() + sessionLifetimeMs })
  setSessionCookie(response, token)
  return response.json({ account: publicAccount(account) })
})
app.post('/api/auth/logout', (request, response) => {
  const token = getSessionToken(request.headers.cookie)
  if (/^[a-f0-9]{64}$/.test(token)) sessions.delete(hashSessionToken(token))
  clearSessionCookie(response)
  response.set('Cache-Control', 'no-store')
  return response.json({ ok: true })
})
app.use('/api', (request, response, next) => {
  const account = getSessionAccount(getSessionToken(request.headers.cookie))
  if (!account) return response.status(401).json({ error: 'Sign in to continue.' })
  request.authAccount = account
  return next()
})
app.use('/api/servers/:serverId', (request, response, next) => {
  const server = getServer(request.params.serverId)
  if (!server || !isServerMember(server, request.authAccount.id)) {
    return response.status(404).json({ error: 'Server not found.' })
  }
  return next()
})
app.get('/api/members', (request, response) => {
  const name = typeof request.query.name === 'string' ? request.query.name.trim() : ''
  if (!name || name.length > 32) return response.status(400).json({ error: 'Enter a valid community member name.' })
  const account = accounts.find((item) => item.displayName.toLowerCase() === name.toLowerCase())
  const member = account ? getFriendProfile(account.id) : null
  return response.json({ member })
})
app.get('/api/members/:memberId', (request, response) => {
  const memberId = request.params.memberId
  if (!isValidDmUserId(memberId)) return response.status(400).json({ error: 'Choose a valid community member.' })
  const member = getFriendProfile(memberId)
  if (!member) return response.status(404).json({ error: 'That REFORM account could not be found.' })
  return response.json({ member })
})
app.get('/api/friends', (request, response) => {
  const friends = getFriendIds(request.authAccount.id)
    .map(getFriendProfile)
    .filter(Boolean)
    .sort((first, second) => Number(second.online) - Number(first.online) || first.name.localeCompare(second.name))
  return response.json({ friends })
})
app.post('/api/friends/:friendId', async (request, response) => {
  const { id: accountId } = request.authAccount
  const friendId = request.params.friendId
  if (!isValidDmUserId(friendId) || friendId === accountId) {
    return response.status(400).json({ error: 'Choose a valid community member to add.' })
  }
  const friend = getFriendProfile(friendId)
  if (!friend) return response.status(404).json({ error: 'That REFORM account could not be found.' })
  if (isFriend(accountId, friendId)) return response.json({ friend, isFriend: true })
  if (getFriendIds(accountId).length >= 500) return response.status(409).json({ error: 'Your friends list has reached its 500-member limit.' })

  const previousFriendIds = friendships[accountId]
  const previousTheirFriendIds = friendships[friendId]
  friendships[accountId] = [...getFriendIds(accountId), friendId]
  friendships[friendId] = [...getFriendIds(friendId), accountId]
  try {
    await persistFriendships()
  } catch (error) {
    if (previousFriendIds) friendships[accountId] = previousFriendIds
    else delete friendships[accountId]
    if (previousTheirFriendIds) friendships[friendId] = previousTheirFriendIds
    else delete friendships[friendId]
    console.error('Failed to save friendship:', error)
    return response.status(500).json({ error: 'The friend could not be added. Please try again.' })
  }
  const notification = { member: getFriendProfile(accountId), createdAt: new Date().toISOString() }
  notifyAccount(friendId, 'friend:added', notification)
  return response.status(201).json({ friend, isFriend: true })
})
app.delete('/api/friends/:friendId', async (request, response) => {
  const { id: accountId } = request.authAccount
  const friendId = request.params.friendId
  if (!isValidDmUserId(friendId) || friendId === accountId) {
    return response.status(400).json({ error: 'Choose a valid friend to remove.' })
  }
  if (!isFriend(accountId, friendId)) return response.status(404).json({ error: 'That member is not on your friends list.' })

  const previousFriendIds = friendships[accountId]
  const previousTheirFriendIds = friendships[friendId]
  friendships[accountId] = previousFriendIds.filter((id) => id !== friendId)
  friendships[friendId] = (previousTheirFriendIds ?? []).filter((id) => id !== accountId)
  try {
    await persistFriendships()
  } catch (error) {
    friendships[accountId] = previousFriendIds
    if (previousTheirFriendIds) friendships[friendId] = previousTheirFriendIds
    else delete friendships[friendId]
    console.error('Failed to remove friendship:', error)
    return response.status(500).json({ error: 'The friend could not be removed. Please try again.' })
  }
  return response.json({ ok: true })
})
app.patch('/api/auth/profile', express.json({ limit: '10kb' }), async (request, response) => {
  const displayName = typeof request.body?.username === 'string' ? request.body.username.trim().replace(/\s+/g, ' ') : ''
  if (!isValidAccountName(displayName)) {
    return response.status(400).json({ error: 'Use a gamer name of 1–32 letters, numbers, spaces, periods, hyphens, or underscores.' })
  }
  const account = request.authAccount
  if (accounts.some((item) => item.id !== account.id && item.displayName.toLowerCase() === displayName.toLowerCase())) {
    return response.status(409).json({ error: 'That username is already in use.' })
  }
  const previousName = account.displayName
  account.displayName = displayName
  try {
    await persistAccounts()
  } catch (error) {
    account.displayName = previousName
    console.error('Failed to update account profile:', error)
    return response.status(500).json({ error: 'Your display name could not be saved.' })
  }
  return response.json({ account: publicAccount(account) })
})
app.post('/api/profile-pictures', express.json({ limit: '7mb' }), async (request, response) => {
  const profileId = typeof request.body?.profileId === 'string' ? request.body.profileId : ''
  const data = typeof request.body?.data === 'string' ? request.body.data : ''
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data)
  if (profileId !== request.authAccount.id || !match) {
    return response.status(400).json({ error: 'Choose a PNG, JPEG, GIF, or WebP profile picture.' })
  }
  const fileData = Buffer.from(match[2], 'base64')
  if (fileData.length === 0 || fileData.length > maxAttachmentSize || fileData.toString('base64') !== match[2]) {
    return response.status(400).json({ error: 'Profile pictures must be no larger than 5 MB.' })
  }
  const detectedType = fileData.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : fileData.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(fileData.subarray(0, 6).toString('ascii')) ? 'image/gif'
        : fileData.subarray(0, 4).toString('ascii') === 'RIFF' && fileData.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
          : null
  if (detectedType !== match[1]) return response.status(400).json({ error: 'The profile picture contents do not match the selected image type.' })

  const filePath = join(profilePictureDirectory, profileId)
  const previousType = profilePictures[profileId]
  let previousData
  try {
    if (previousType) previousData = await readFile(filePath)
    await writeFile(filePath, fileData)
    profilePictures[profileId] = detectedType
    await persistProfilePictures()
  } catch (error) {
    if (previousType) {
      profilePictures[profileId] = previousType
      if (previousData) await writeFile(filePath, previousData)
    } else {
      delete profilePictures[profileId]
    }
    console.error('Failed to save profile picture:', error)
    return response.status(500).json({ error: 'The profile picture could not be saved.' })
  }
  return response.json({ url: `/api/profile-pictures/${encodeURIComponent(profileId)}` })
})
app.get('/api/profile-pictures/:profileId', async (request, response) => {
  const profileId = request.params.profileId
  const mimeType = profilePictures[profileId]
  if (!/^[\w-]{1,80}$/.test(profileId) || !mimeType) return response.status(404).json({ error: 'Profile picture not found.' })
  try {
    const image = await readFile(join(profilePictureDirectory, profileId))
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('Cache-Control', 'private, max-age=3600')
    response.set('Content-Type', mimeType)
    return response.send(image)
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ error: 'Profile picture file is no longer available.' })
    console.error('Failed to read profile picture:', error)
    return response.status(500).json({ error: 'The profile picture could not be loaded.' })
  }
})
app.post('/api/attachments', express.json({ limit: '7mb' }), async (request, response) => {
  const { name, mimeType, data } = request.body ?? {}
  if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return response.status(400).json({ error: 'The attachment data is invalid.' })
  }
  const fileData = Buffer.from(data, 'base64')
  if (fileData.length === 0 || fileData.length > maxAttachmentSize || fileData.toString('base64') !== data) {
    return response.status(400).json({ error: 'Attachments must be no larger than 5 MB.' })
  }
  const detectedImageType = fileData.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : fileData.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(fileData.subarray(0, 6).toString('ascii')) ? 'image/gif'
        : fileData.subarray(0, 4).toString('ascii') === 'RIFF' && fileData.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
          : fileData.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf'
            : null
  let safeMimeType = detectedImageType
  if (!safeMimeType && mimeType === 'text/plain' && !fileData.includes(0)) safeMimeType = 'text/plain'
  if (!safeMimeType && (rasterImageTypes.has(mimeType) || mimeType === 'application/pdf' || mimeType === 'text/plain')) {
    return response.status(400).json({ error: 'The file contents do not match the selected file type.' })
  }
  safeMimeType ??= 'application/octet-stream'

  const id = randomUUID()
  const safeName = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'attachment'
  try {
    await writeFile(join(attachmentDirectory, id), fileData, { flag: 'wx' })
  } catch (error) {
    console.error('Failed to store chat attachment:', error)
    return response.status(500).json({ error: 'The attachment could not be saved.' })
  }
  response.status(201).json({ id, name: safeName, mimeType: safeMimeType, size: fileData.length })
})
app.use('/api/channels', express.json({ limit: '10kb' }))
app.use('/api/servers', express.json({ limit: '10kb' }))
app.get('/api/dms/:userId', (request, response) => {
  const { userId } = request.params
  if (userId !== request.authAccount.id) return response.status(403).json({ error: 'You can only view your own conversations.' })
  if (!isValidDmUserId(userId)) return response.status(400).json({ error: 'Choose a valid profile.' })
  const conversations = directConversations.filter((conversation) =>
    conversation.participants.some((participant) => participant.id === userId))
    .map((conversation) => {
      const contact = conversation.participants.find((participant) => participant.id !== userId)
      const lastMessage = conversation.messages.at(-1) ?? null
      return {
        contact: contact ? { id: contact.id, name: contact.name } : null,
        lastMessage,
        streak: getDmStreak(conversation),
      }
    })
    .filter(({ contact }) => contact)
    .sort((first, second) => (second.lastMessage?.createdAt ?? '').localeCompare(first.lastMessage?.createdAt ?? ''))
  return response.json({ conversations })
})
app.get('/api/dms/:userId/:contactId', (request, response) => {
  const { userId, contactId } = request.params
  if (userId !== request.authAccount.id) return response.status(403).json({ error: 'You can only view your own conversations.' })
  if (!isValidDmUserId(userId) || !isValidDmUserId(contactId) || userId === contactId) {
    return response.status(400).json({ error: 'Choose a valid direct-message contact.' })
  }
  const conversation = getDmConversation(userId, contactId)
  const contact = conversation?.participants.find((participant) => participant.id === contactId)
  return response.json({
    messages: conversation?.messages ?? [],
    contact: contact ? { id: contact.id, name: contact.name } : null,
    streak: getDmStreak(conversation),
  })
})
app.get('/api/servers', (request, response) => response.json(getMemberServers(request.authAccount.id)))
app.post('/api/servers', async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    return response.status(400).json({ error: 'Use a server name of 1–32 letters, numbers, spaces, hyphens, or underscores.' })
  }
  if (getMemberServers(request.authAccount.id).length >= 30) return response.status(409).json({ error: 'You have reached the maximum of 30 servers.' })
  const server = {
    id: randomUUID(),
    name,
    ownerId: request.authAccount.id,
    members: [request.authAccount.id],
    inviteCode: randomBytes(9).toString('base64url'),
    textChannels: [
      { label: 'welcome', topic: 'Welcome to the community.' },
      { label: 'lobby', topic: 'Chat with your community.' },
    ],
    voiceChannels: [{ label: 'Squad Room' }],
  }
  servers.push(server)
  try {
    await persistChannels()
  } catch (error) {
    servers = servers.filter((item) => item.id !== server.id)
    console.error('Failed to persist server:', error)
    return response.status(500).json({ error: 'The server could not be saved.' })
  }
  broadcastServerLists()
  return response.status(201).json({ server: publicServer(server) })
})
app.patch('/api/servers/:serverId', async (request, response) => {
  const server = getServer(request.params.serverId)
  if (!server) return response.status(404).json({ error: 'Server not found.' })
  if (server.ownerId !== request.authAccount.id) return response.status(403).json({ error: 'Only the server creator can rename this server.' })
  const name = typeof request.body?.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    return response.status(400).json({ error: 'Use a server name of 1–32 letters, numbers, spaces, hyphens, or underscores.' })
  }
  const previousName = server.name
  server.name = name
  try {
    await persistChannels()
  } catch (error) {
    server.name = previousName
    console.error('Failed to rename server:', error)
    return response.status(500).json({ error: 'The server name could not be saved.' })
  }
  broadcastServerLists()
  return response.json({ server: publicServer(server) })
})
app.post('/api/servers/:serverId/invites', async (request, response) => {
  const server = getServer(request.params.serverId)
  if (!server.inviteCode) {
    server.inviteCode = randomBytes(9).toString('base64url')
    try {
      await persistChannels()
    } catch (error) {
      console.error('Failed to save server invite:', error)
      return response.status(500).json({ error: 'The server invite could not be created.' })
    }
  }
  return response.status(201).json({ inviteCode: server.inviteCode })
})
app.post('/api/server-invites/:inviteCode', async (request, response) => {
  const server = servers.find((item) => item.inviteCode === request.params.inviteCode)
  if (!server) return response.status(404).json({ error: 'That invite is invalid or has expired.' })
  if (isServerMember(server, request.authAccount.id)) return response.json({ server: publicServer(server), joined: false })
  if (getMemberServers(request.authAccount.id).length >= 30) {
    return response.status(409).json({ error: 'You have reached the maximum of 30 servers.' })
  }
  const previousMembers = server.members
  server.members = [...previousMembers, request.authAccount.id]
  try {
    await persistChannels()
  } catch (error) {
    server.members = previousMembers
    console.error('Failed to join server from invite:', error)
    return response.status(500).json({ error: 'Could not join the server. Please try again.' })
  }
  broadcastServerLists()
  return response.json({ server: publicServer(server), joined: true })
})
let serverDeletionQueue = Promise.resolve()
const serializeServerDeletion = (operation) => {
  const currentOperation = serverDeletionQueue.then(operation)
  serverDeletionQueue = currentOperation.then(() => undefined, () => undefined)
  return currentOperation
}
app.delete('/api/servers/:serverId', (request, response) => serializeServerDeletion(async () => {
  const serverId = request.params.serverId
  if (serverId === defaultServerId) {
    return response.status(409).json({ error: 'The default REFORM server cannot be deleted.' })
  }
  const server = getServer(serverId)
  if (!server) return response.status(404).json({ error: 'Server not found.' })
  if (server.ownerId !== request.authAccount.id) return response.status(403).json({ error: 'Only the server creator can delete this server.' })

  const removedMessages = messages.filter((message) => message.serverId === serverId)
  const removedAttachmentIds = new Set(removedMessages.flatMap((message) => message.attachments ?? [])
    .map((attachment) => attachment.id)
    .filter((id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))
  const previousServers = servers
  const previousMessages = messages
  servers = servers.filter((item) => item.id !== serverId)
  messages = messages.filter((message) => message.serverId !== serverId)
  try {
    await persistChannels()
    await persistMessages()
  } catch (error) {
    servers = previousServers
    messages = previousMessages
    try {
      await Promise.all([persistChannels(), persistMessages()])
    } catch (rollbackError) {
      console.error('Failed to restore server data after deletion failed:', rollbackError)
    }
    console.error('Failed to delete server:', error)
    return response.status(500).json({ error: 'The server could not be deleted. Its data was restored where possible.' })
  }

  const retainedAttachmentIds = new Set(messages.flatMap((message) => message.attachments ?? [])
    .map((attachment) => attachment.id))
  for (const attachmentId of removedAttachmentIds) {
    if (retainedAttachmentIds.has(attachmentId)) continue
    try {
      await unlink(join(attachmentDirectory, attachmentId))
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Failed to remove orphaned attachment ${attachmentId}:`, error)
    }
  }

  for (const connectedSocket of io.sockets.sockets.values()) {
    if (connectedSocket.data.voiceServerId === serverId) leaveVoice(connectedSocket)
    if (connectedSocket.data.textServerId === serverId) {
      if (connectedSocket.data.textChannel) connectedSocket.leave(textRoom(serverId, connectedSocket.data.textChannel))
      connectedSocket.data.textServerId = null
      connectedSocket.data.textChannel = null
    }
  }
  broadcastServerLists()
  return response.json({ serverId, deleted: true })
}))
app.get('/api/channels', (request, response) => {
  const server = getServer(defaultServerId)
  if (!isServerMember(server, request.authAccount.id)) return response.status(404).json({ error: 'Server not found.' })
  return response.json(getChannelLists(server))
})
app.post('/api/channels', async (request, response) => {
  const serverId = typeof request.body?.serverId === 'string' ? request.body.serverId : defaultServerId
  const server = getServer(serverId)
  if (!server || !isServerMember(server, request.authAccount.id)) return response.status(404).json({ error: 'Server not found.' })
  const type = request.body?.type
  const name = typeof request.body?.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : ''
  if (!['text', 'voice'].includes(type) || !name || name.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    return response.status(400).json({ error: 'Use a channel name of 1–32 letters, numbers, spaces, hyphens, or underscores.' })
  }

  if (type === 'text') {
    const label = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
    if (server.textChannels.some((item) => item.label === label)) return response.status(409).json({ error: 'A text channel with that name already exists.' })
    if (server.textChannels.length >= 40) return response.status(409).json({ error: 'This server already has the maximum number of text channels.' })
    const topic = typeof request.body.topic === 'string' ? request.body.topic.trim().slice(0, 120) : ''
    const channel = { label, topic: topic || 'Chat with your community.', createdBy: request.authAccount.id }
    server.textChannels.push(channel)
    try {
      await persistChannels()
    } catch (error) {
      server.textChannels = server.textChannels.filter((item) => item.label !== label)
      console.error('Failed to persist text channel:', error)
      return response.status(500).json({ error: 'The text channel could not be saved.' })
    }
    broadcastChannelLists(server)
    return response.status(201).json({ type, channel })
  }

  const duplicateVoiceChannel = server.voiceChannels.some((item) => item.label.toLowerCase() === name.toLowerCase())
  if (duplicateVoiceChannel) return response.status(409).json({ error: 'A voice lounge with that name already exists.' })
  if (server.voiceChannels.length >= 40) return response.status(409).json({ error: 'This server already has the maximum number of voice lounges.' })
  const channel = { label: name }
  server.voiceChannels.push(channel)
  try {
    await persistChannels()
  } catch (error) {
    server.voiceChannels = server.voiceChannels.filter((item) => item.label !== name)
    console.error('Failed to persist voice lounge:', error)
    return response.status(500).json({ error: 'The voice lounge could not be saved.' })
  }
  broadcastChannelLists(server)
  for (const socket of io.sockets.sockets.values()) {
    if (isServerMember(server, socket.data.account.id)) socket.emit('voice:members', { serverId, channel: name, members: [] })
  }
  return response.status(201).json({ type, channel })
})
let channelMutationQueue = Promise.resolve()
const serializeChannelMutation = (operation) => {
  const currentOperation = channelMutationQueue.then(operation)
  channelMutationQueue = currentOperation.then(() => undefined, () => undefined)
  return currentOperation
}
app.patch('/api/servers/:serverId/channels/:channelLabel', (request, response) => serializeChannelMutation(async () => {
  const { serverId, channelLabel } = request.params
  const server = getServer(serverId)
  if (!server) return response.status(404).json({ error: 'Server not found.' })
  const channel = server.textChannels.find((item) => item.label === channelLabel)
  if (!channel) return response.status(404).json({ error: 'Text channel not found.' })
  if (channel.createdBy !== request.authAccount.id) {
    return response.status(403).json({ error: 'Only the member who created this text channel can rename it.' })
  }

  const name = typeof request.body?.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 32 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    return response.status(400).json({ error: 'Use a channel name of 1–32 letters, numbers, spaces, hyphens, or underscores.' })
  }
  const label = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
  if (server.textChannels.some((item) => item.label !== channelLabel && item.label === label)) {
    return response.status(409).json({ error: 'A text channel with that name already exists.' })
  }
  if (label === channelLabel) return response.json({ channel })

  const previousMessages = messages
  channel.label = label
  messages = messages.map((message) => message.serverId === serverId && message.channel === channelLabel
    ? { ...message, channel: label }
    : message)
  try {
    await persistChannels()
    await persistMessages()
  } catch (error) {
    channel.label = channelLabel
    messages = previousMessages
    try {
      await Promise.all([persistChannels(), persistMessages()])
    } catch (rollbackError) {
      console.error('Failed to restore channel data after rename failed:', rollbackError)
    }
    console.error('Failed to rename text channel:', error)
    return response.status(500).json({ error: 'The text channel could not be renamed. Its data was restored where possible.' })
  }

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.textServerId !== serverId || socket.data.textChannel !== channelLabel) continue
    socket.leave(textRoom(serverId, channelLabel))
    socket.data.textChannel = label
    socket.join(textRoom(serverId, label))
  }
  for (const socket of io.sockets.sockets.values()) {
    if (isServerMember(server, socket.data.account.id)) socket.emit('channel:renamed', { serverId, previousLabel: channelLabel, label })
  }
  broadcastChannelLists(server)
  return response.json({ channel })
}))
app.delete('/api/servers/:serverId/channels/:channelLabel', (request, response) => serializeChannelMutation(async () => {
  const { serverId, channelLabel } = request.params
  const server = getServer(serverId)
  if (!server) return response.status(404).json({ error: 'Server not found.' })
  const channel = server.textChannels.find((item) => item.label === channelLabel)
  if (!channel) return response.status(404).json({ error: 'Text channel not found.' })
  if (channel.createdBy !== request.authAccount.id) {
    return response.status(403).json({ error: 'Only the member who created this text channel can delete it.' })
  }

  const previousChannels = server.textChannels
  const previousMessages = messages
  const removedMessages = messages.filter((message) => message.serverId === serverId && message.channel === channelLabel)
  const removedAttachmentIds = new Set(removedMessages.flatMap((message) => message.attachments ?? [])
    .map((attachment) => attachment.id)
    .filter((id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))
  server.textChannels = server.textChannels.filter((item) => item.label !== channelLabel)
  messages = messages.filter((message) => message.serverId !== serverId || message.channel !== channelLabel)
  try {
    await persistChannels()
    await persistMessages()
  } catch (error) {
    server.textChannels = previousChannels
    messages = previousMessages
    try {
      await Promise.all([persistChannels(), persistMessages()])
    } catch (rollbackError) {
      console.error('Failed to restore channel data after deletion failed:', rollbackError)
    }
    console.error('Failed to delete text channel:', error)
    return response.status(500).json({ error: 'The text channel could not be deleted. Its data was restored where possible.' })
  }

  const retainedAttachmentIds = new Set(messages.flatMap((message) => message.attachments ?? []).map((attachment) => attachment.id))
  for (const attachmentId of removedAttachmentIds) {
    if (retainedAttachmentIds.has(attachmentId)) continue
    try {
      await unlink(join(attachmentDirectory, attachmentId))
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Failed to remove orphaned attachment ${attachmentId}:`, error)
    }
  }
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.textServerId !== serverId || socket.data.textChannel !== channelLabel) continue
    socket.leave(textRoom(serverId, channelLabel))
    socket.data.textServerId = null
    socket.data.textChannel = null
  }
  for (const socket of io.sockets.sockets.values()) {
    if (isServerMember(server, socket.data.account.id)) socket.emit('channel:deleted', { serverId, label: channelLabel })
  }
  broadcastChannelLists(server)
  return response.json({ serverId, deleted: true, label: channelLabel })
}))
app.get('/api/attachments/:id', async (request, response) => {
  const id = request.params.id
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return response.status(404).json({ error: 'Attachment not found.' })
  }
  const message = messages.find((item) => item.attachments?.some((attachment) => attachment.id === id)
    && isServerMember(getServer(item.serverId), request.authAccount.id))
  const attachment = message?.attachments?.find((item) => item.id === id)
  if (!attachment) return response.status(404).json({ error: 'Attachment not found.' })
  try {
    const fileData = await readFile(join(attachmentDirectory, id))
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('Cache-Control', 'private, max-age=3600')
    response.set('Content-Type', attachment.mimeType)
    response.set('Content-Disposition', attachment.mimeType.startsWith('image/')
      ? 'inline'
      : `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
    response.send(fileData)
  } catch (error) {
    if (error.code === 'ENOENT') return response.status(404).json({ error: 'Attachment file is no longer available.' })
    console.error('Failed to read chat attachment:', error)
    response.status(500).json({ error: 'The attachment could not be loaded.' })
  }
})
app.get('/api/servers/:serverId/channels/:channel/messages', (request, response) => {
  const server = getServer(request.params.serverId)
  const channel = request.params.channel
  if (!server || !isChatChannel(server, channel)) return response.status(404).json({ error: 'Unknown chat channel.' })
  response.json(messages.filter((message) => message.serverId === server.id && message.channel === channel).slice(-100))
})
app.get('/api/channels/:channel/messages', (request, response) => {
  const channel = request.params.channel
  const server = getServer(defaultServerId)
  if (!isServerMember(server, request.authAccount.id) || !isChatChannel(server, channel)) return response.status(404).json({ error: 'Unknown chat channel.' })
  response.json(messages.filter((message) => message.serverId === defaultServerId && message.channel === channel).slice(-100))
})

app.use(express.static(frontendBuildDirectory))
app.use((request, response, next) => {
  if (request.method !== 'GET' || request.path.startsWith('/api/') || request.path === '/api'
    || request.path.startsWith('/socket.io')) return next()
  response.sendFile('index.html', { root: frontendBuildDirectory, headers: { 'Cache-Control': 'no-cache' } }, (error) => {
    if (error) next(error)
  })
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),
  },
})
const voiceMembers = new Map()
const recentWelcomes = new Map()
const onlineMembers = new Map()
const directCalls = new Map()
const directCallByAccount = new Map()
const broadcastServerLists = () => {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit('servers:updated', getMemberServers(socket.data.account.id))
  }
}
const broadcastChannelLists = (server) => {
  for (const socket of io.sockets.sockets.values()) {
    if (isServerMember(server, socket.data.account.id)) socket.emit('channels:updated', getChannelLists(server))
  }
}

const getOnlineMembers = () => [...new Map([...onlineMembers.values()]
  .map(({ id, name, avatarUrl }) => [id, { id, name, ...(avatarUrl ? { avatarUrl } : {}) }])).values()]
const broadcastOnlineMembers = () => io.emit('members:list', getOnlineMembers())
const notifyAccount = (accountId, event, payload) => {
  for (const [socketId, member] of onlineMembers) {
    if (member.id === accountId) io.to(socketId).emit(event, payload)
  }
}
const notifyAccountExcept = (accountId, excludedSocketId, event, payload) => {
  for (const [socketId, member] of onlineMembers) {
    if (member.id === accountId && socketId !== excludedSocketId) io.to(socketId).emit(event, payload)
  }
}
const finishDirectCall = (call, reason) => {
  if (directCalls.get(call.id) !== call) return
  directCalls.delete(call.id)
  if (directCallByAccount.get(call.fromId) === call.id) directCallByAccount.delete(call.fromId)
  if (directCallByAccount.get(call.toId) === call.id) directCallByAccount.delete(call.toId)
  if (call.timeout) clearTimeout(call.timeout)
  const payload = { callId: call.id, reason }
  if (call.callerSocketId) io.to(call.callerSocketId).emit('dm-call:ended', payload)
  if (call.calleeSocketId) io.to(call.calleeSocketId).emit('dm-call:ended', payload)
  if (reason === 'cancelled' || reason === 'missed' || reason === 'declined') {
    notifyAccountExcept(call.toId, call.calleeSocketId, 'dm-call:ended', payload)
  }
}

const emitVoiceMembers = (serverId, channel) => {
  const key = voiceRoomKey(serverId, channel)
  const members = [...(voiceMembers.get(key)?.values() ?? [])].map(({ author }) => author)
  for (const socket of io.sockets.sockets.values()) {
    if (isServerMember(getServer(serverId), socket.data.account.id)) socket.emit('voice:members', { serverId, channel, members })
  }
}

const leaveVoice = (socket) => {
  const channel = socket.data.voiceChannel
  const serverId = socket.data.voiceServerId
  if (!channel || !serverId) return
  const key = voiceRoomKey(serverId, channel)
  socket.to(voiceRoom(serverId, channel)).emit('voice:peer-left', { id: socket.id, serverId, channel })
  socket.leave(voiceRoom(serverId, channel))
  voiceMembers.get(key)?.delete(socket.id)
  if (voiceMembers.get(key)?.size === 0) voiceMembers.delete(key)
  socket.data.voiceChannel = null
  socket.data.voiceServerId = null
  emitVoiceMembers(serverId, channel)
}

io.use((socket, next) => {
  const account = getSessionAccount(getSessionToken(socket.handshake.headers.cookie))
  if (!account) return next(new Error('Sign in to connect.'))
  socket.data.account = account
  return next()
})

io.on('connection', (socket) => {
  const reactionUserId = socket.data.account.id
  socket.data.reactionUserId = reactionUserId
  socket.emit('members:list', getOnlineMembers())

  const memberServers = servers.filter((server) => isServerMember(server, reactionUserId))
  socket.emit('servers:list', memberServers.map(publicServer))
  for (const server of memberServers) {
    socket.emit('channels:list', getChannelLists(server))
    for (const { label: channel } of server.voiceChannels) {
      const key = voiceRoomKey(server.id, channel)
      socket.emit('voice:members', {
        serverId: server.id,
        channel,
        members: [...(voiceMembers.get(key)?.values() ?? [])].map(({ author }) => author),
      })
    }
  }

  socket.on('channel:join', (payload) => {
    const serverId = payload?.serverId
    const channel = payload?.channel
    const server = getServer(serverId)
    if (!server || !isServerMember(server, reactionUserId) || !isChatChannel(server, channel)) return
    const currentChannel = socket.data.textChannel
    const currentServerId = socket.data.textServerId
    if (currentChannel && currentServerId) socket.leave(textRoom(currentServerId, currentChannel))
    socket.data.textChannel = channel
    socket.data.textServerId = serverId
    socket.join(textRoom(serverId, channel))
  })

  socket.on('member:join', async (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : null
    const server = serverId ? getServer(serverId) : null
    const author = socket.data.account.displayName
    if (!isValidDmName(author)) return reply({ error: 'Your profile name is invalid.' })

    socket.data.profileName = author
    const avatarUrl = profilePictures[reactionUserId] ? `/api/profile-pictures/${encodeURIComponent(reactionUserId)}` : undefined
    onlineMembers.set(socket.id, { id: reactionUserId, name: author, ...(avatarUrl ? { avatarUrl } : {}) })
    broadcastOnlineMembers()
    reply({ ok: true })
    if (!server || !isServerMember(server, reactionUserId)) return
    socket.data.welcomeSent = true
    if (socket.data.welcomePosted) return
    socket.data.welcomePosted = true
    const now = Date.now()
    for (const [member, timestamp] of recentWelcomes) {
      if (now - timestamp > 60_000) recentWelcomes.delete(member)
    }
    if (now - (recentWelcomes.get(author) ?? 0) < 60_000) return
    recentWelcomes.set(author, now)
    const message = {
      id: randomUUID(),
      serverId,
      channel: 'welcome',
      author: 'REFORM welcomes',
      content: `👋 Welcome ${author} to the community! Say hello and share what you're playing.`,
      createdAt: new Date().toISOString(),
      kind: 'welcome',
    }
    messages.push(message)
    try {
      await persistMessages()
    } catch (error) {
      messages = messages.filter((item) => item.id !== message.id)
      if (recentWelcomes.get(author) === now) recentWelcomes.delete(author)
      socket.data.welcomeSent = false
      console.error('Failed to persist member welcome:', error)
      return
    }
    io.to(textRoom(serverId, 'welcome')).emit('chat:message', message)
  })

  socket.on('member:profile', (payload) => {
    const name = socket.data.account.displayName
    if (!isValidDmName(name)) return
    socket.data.profileName = name
    const currentMember = onlineMembers.get(socket.id)
    if (currentMember) onlineMembers.set(socket.id, { ...currentMember, name })
    broadcastOnlineMembers()
  })

  socket.on('dm:join', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const contactId = payload?.contactId
    const userId = socket.data.reactionUserId
    if (!isValidDmUserId(contactId) || contactId === userId) {
      return reply({ error: 'Choose a valid direct-message contact.' })
    }
    const room = dmRoom(userId, contactId)
    const knownConversation = getDmConversation(userId, contactId)
    const contactIsOnline = [...onlineMembers.values()].some((member) => member.id === contactId)
    if (!contactIsOnline && !knownConversation && !isFriend(userId, contactId)) {
      return reply({ error: 'That member is no longer available.' })
    }
    if (socket.data.dmRoom) socket.leave(socket.data.dmRoom)
    socket.data.dmRoom = room
    socket.data.dmContactId = contactId
    socket.join(room)
    return reply({ ok: true })
  })

  socket.on('dm:leave', () => {
    if (socket.data.dmRoom) socket.leave(socket.data.dmRoom)
    socket.data.dmRoom = null
    socket.data.dmContactId = null
  })

  socket.on('dm-call:start', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const fromId = socket.data.reactionUserId
    const toId = payload?.toId
    if (!isValidDmUserId(toId) || toId === fromId || socket.data.dmContactId !== toId
      || socket.data.dmRoom !== dmRoom(fromId, toId) || !accounts.some((account) => account.id === toId)) {
      return reply({ error: 'Open a valid direct conversation before starting a call.' })
    }
    if (directCallByAccount.has(fromId)) return reply({ error: 'You are already in a direct call.' })
    if (directCallByAccount.has(toId)) return reply({ error: 'This member is already in a call.' })
    if (![...onlineMembers.values()].some((member) => member.id === toId)) {
      return reply({ error: 'This member is offline and cannot receive a call.' })
    }

    const call = {
      id: randomUUID(),
      fromId,
      toId,
      fromName: socket.data.profileName,
      callerSocketId: socket.id,
      calleeSocketId: null,
      status: 'ringing',
      timeout: null,
    }
    directCalls.set(call.id, call)
    directCallByAccount.set(fromId, call.id)
    directCallByAccount.set(toId, call.id)
    call.timeout = setTimeout(() => finishDirectCall(call, 'missed'), 30_000)
    reply({ callId: call.id })
    notifyAccount(toId, 'dm-call:incoming', { callId: call.id, fromId, fromName: call.fromName })
  })

  socket.on('dm-call:accept', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const call = directCalls.get(payload?.callId)
    if (!call || call.status !== 'ringing' || call.toId !== socket.data.reactionUserId) {
      return reply({ error: 'This call is no longer available.' })
    }
    if (call.callerSocketId === socket.id || call.calleeSocketId) {
      return reply({ error: 'This call has already been answered.' })
    }
    call.status = 'active'
    call.calleeSocketId = socket.id
    if (call.timeout) clearTimeout(call.timeout)
    call.timeout = null
    const callerPayload = { callId: call.id, peerSocketId: socket.id }
    const calleePayload = { callId: call.id, peerSocketId: call.callerSocketId }
    reply({ ok: true })
    io.to(call.callerSocketId).emit('dm-call:accepted', callerPayload)
    socket.emit('dm-call:accepted', calleePayload)
    notifyAccountExcept(call.toId, socket.id, 'dm-call:answered-elsewhere', { callId: call.id })
  })

  socket.on('dm-call:decline', (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const call = directCalls.get(payload?.callId)
    if (!call || call.status !== 'ringing' || call.toId !== socket.data.reactionUserId) {
      return reply({ error: 'This call is no longer available.' })
    }
    finishDirectCall(call, 'declined')
    reply({ ok: true })
  })

  socket.on('dm-call:end', (payload) => {
    const call = directCalls.get(payload?.callId)
    if (!call || (socket.id !== call.callerSocketId && socket.id !== call.calleeSocketId)) return
    finishDirectCall(call, 'ended')
  })

  socket.on('dm-call:signal', (payload) => {
    const call = directCalls.get(payload?.callId)
    if (!call || call.status !== 'active') return
    const targetId = socket.id === call.callerSocketId ? call.calleeSocketId
      : socket.id === call.calleeSocketId ? call.callerSocketId
        : null
    if (!targetId || payload?.to !== targetId) return
    const signal = {}
    if (payload.description && ['offer', 'answer'].includes(payload.description.type)
      && typeof payload.description.sdp === 'string' && payload.description.sdp.length <= 100_000) {
      signal.description = payload.description
    }
    if (payload.candidate && typeof payload.candidate.candidate === 'string'
      && payload.candidate.candidate.length <= 4096) {
      signal.candidate = payload.candidate
    }
    if (Object.keys(signal).length === 0) return
    io.to(targetId).emit('dm-call:signal', { callId: call.id, from: socket.id, ...signal })
  })

  socket.on('dm:send', async (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const fromId = socket.data.reactionUserId
    const toId = payload?.toId
    const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
    if (!isValidDmUserId(toId) || toId === fromId || socket.data.dmContactId !== toId
      || socket.data.dmRoom !== dmRoom(fromId, toId)) {
      return reply({ error: 'Open a direct conversation before sending a message.' })
    }
    if (!content || content.length > messageLimit) {
      return reply({ error: `Direct messages must contain 1-${messageLimit} characters.` })
    }
    const liveContact = [...onlineMembers.values()].find((member) => member.id === toId)
    let conversation = getDmConversation(fromId, toId)
    const createdConversation = !conversation
    if (!conversation) {
      conversation = {
        id: randomUUID(),
        participants: [
          { id: fromId, name: socket.data.profileName },
          { id: toId, name: liveContact?.name ?? 'Community member' },
        ],
        messages: [],
      }
      directConversations.push(conversation)
    } else {
      const sender = conversation.participants.find((participant) => participant.id === fromId)
      if (sender) sender.name = socket.data.profileName
      const recipient = conversation.participants.find((participant) => participant.id === toId)
      if (recipient && liveContact) recipient.name = liveContact.name
    }
    const avatarUrl = profilePictures[fromId] ? `/api/profile-pictures/${encodeURIComponent(fromId)}` : undefined
    const message = {
      id: randomUUID(),
      fromId,
      fromName: socket.data.profileName,
      toId,
      content,
      ...(avatarUrl ? { avatarUrl } : {}),
      createdAt: new Date().toISOString(),
    }
    conversation.messages.push(message)
    const streak = getDmStreak(conversation)
    try {
      await persistDirectMessages()
    } catch (error) {
      conversation.messages.pop()
      if (createdConversation) directConversations = directConversations.filter((item) => item.id !== conversation.id)
      console.error('Failed to persist direct message:', error)
      return reply({ error: 'The direct message could not be saved.' })
    }
    io.to(dmRoom(fromId, toId)).emit('dm:message', { conversationId: conversation.id, message, streak })
    notifyAccount(toId, 'dm:notification', {
      fromId,
      fromName: socket.data.profileName,
      content,
      createdAt: message.createdAt,
    })
    return reply({ message, streak })
  })

  socket.on('chat:send', async (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const serverId = payload?.serverId
    const channel = payload?.channel
    const server = getServer(serverId)
    const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
    const author = socket.data.profileName
    const requestedAttachments = payload?.attachments ?? []
    if (!server || !isChatChannel(server, channel)
      || socket.data.textServerId !== serverId || socket.data.textChannel !== channel) {
      return reply({ error: 'Join a valid channel before sending messages.' })
    }
    if (!Array.isArray(requestedAttachments) || requestedAttachments.length > attachmentLimit) {
      return reply({ error: `Attach up to ${attachmentLimit} files per message.` })
    }
    if ((!content && requestedAttachments.length === 0) || content.length > messageLimit || !author) {
      return reply({ error: `Messages must have an author and contain 1-${messageLimit} characters.` })
    }

    const attachments = []
    try {
      for (const item of requestedAttachments) {
        if (!item || typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
          || typeof item.name !== 'string' || typeof item.mimeType !== 'string' || !attachmentTypes.has(item.mimeType)) {
          return reply({ error: 'One or more attachments are invalid.' })
        }
        const fileInfo = await stat(join(attachmentDirectory, item.id))
        if (!fileInfo.isFile() || fileInfo.size <= 0 || fileInfo.size > maxAttachmentSize || item.size !== fileInfo.size) {
          return reply({ error: 'One or more attachments are no longer available.' })
        }
        attachments.push({ id: item.id, name: item.name.slice(0, 120), mimeType: item.mimeType, size: fileInfo.size })
      }
    } catch (error) {
      if (error.code === 'ENOENT') return reply({ error: 'One or more attachments are no longer available.' })
      console.error('Failed to verify chat attachments:', error)
      return reply({ error: 'The attachments could not be verified.' })
    }

    const currentServer = getServer(serverId)
    if (!currentServer || !isChatChannel(currentServer, channel)
      || socket.data.textServerId !== serverId || socket.data.textChannel !== channel) {
      return reply({ error: 'Join a valid channel before sending messages.' })
    }

    const authorId = socket.data.reactionUserId
    const avatarUrl = profilePictures[authorId] ? `/api/profile-pictures/${encodeURIComponent(authorId)}` : undefined
    const message = { id: randomUUID(), serverId, channel, author, authorId, ...(avatarUrl ? { avatarUrl } : {}), content, ...(attachments.length ? { attachments } : {}), createdAt: new Date().toISOString(), reactions: {} }
    messages.push(message)
    try {
      await persistMessages()
    } catch (error) {
      messages = messages.filter((item) => item.id !== message.id)
      console.error('Failed to persist chat message:', error)
      return reply({ error: 'The message could not be saved. Please try again.' })
    }
    const savedMessageServer = getServer(serverId)
    if (!savedMessageServer || !isChatChannel(savedMessageServer, channel)
      || !messages.some((item) => item.id === message.id)) {
      return reply({ error: 'The channel changed before the message could be sent.' })
    }
    io.to(textRoom(serverId, channel)).emit('chat:message', message)
    reply({ message })
  })

  socket.on('chat:reaction', async (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {}
    const serverId = socket.data.textServerId
    const channel = socket.data.textChannel
    const messageId = payload?.messageId
    const emoji = payload?.emoji
    if (!serverId || !channel || typeof messageId !== 'string' || !allowedReactions.has(emoji)) {
      return reply({ error: 'Choose a valid reaction in a joined text channel.' })
    }
    const message = messages.find((item) => item.id === messageId && item.serverId === serverId && item.channel === channel)
    if (!message) return reply({ error: 'That chat message is no longer available.' })

    const previousReactions = message.reactions ?? {}
    const reactionUsers = [...(previousReactions[emoji] ?? [])]
    const userIndex = reactionUsers.indexOf(socket.data.reactionUserId)
    if (userIndex === -1) reactionUsers.push(socket.data.reactionUserId)
    else reactionUsers.splice(userIndex, 1)
    const nextReactions = { ...previousReactions }
    if (reactionUsers.length) nextReactions[emoji] = reactionUsers
    else delete nextReactions[emoji]
    message.reactions = nextReactions
    try {
      await persistMessages()
    } catch (error) {
      message.reactions = previousReactions
      console.error('Failed to persist chat reaction:', error)
      return reply({ error: 'The reaction could not be saved. Please try again.' })
    }
    io.to(textRoom(serverId, channel)).emit('chat:reaction', { messageId, reactions: nextReactions })
    reply({ reactions: nextReactions })
  })

  socket.on('voice:join', (payload) => {
    const serverId = payload?.serverId
    const channel = payload?.channel
    const server = getServer(serverId)
    const author = socket.data.account.displayName
    if (!server || !isServerMember(server, reactionUserId)
      || typeof channel !== 'string' || !server.voiceChannels.some((item) => item.label === channel) || !author) return
    leaveVoice(socket)
    socket.data.voiceChannel = channel
    socket.data.voiceServerId = serverId
    socket.join(voiceRoom(serverId, channel))
    const key = voiceRoomKey(serverId, channel)
    if (!voiceMembers.has(key)) voiceMembers.set(key, new Map())
    voiceMembers.get(key).set(socket.id, { userId: socket.data.account.id, author, muted: false, videoMode: null })
    socket.emit('voice:roster', {
      serverId,
      channel,
      peers: [...voiceMembers.get(key)].filter(([id]) => id !== socket.id).map(([id, member]) => ({ id, ...member })),
    })
    socket.to(voiceRoom(serverId, channel)).emit('voice:peer-joined', { id: socket.id, userId: socket.data.account.id, author, muted: false, videoMode: null, serverId, channel })
    emitVoiceMembers(serverId, channel)
  })

  socket.on('voice:mute', (payload) => {
    const serverId = socket.data.voiceServerId
    const channel = socket.data.voiceChannel
    const key = serverId && channel ? voiceRoomKey(serverId, channel) : null
    const member = key ? voiceMembers.get(key)?.get(socket.id) : undefined
    if (!serverId || !channel || !member || typeof payload?.muted !== 'boolean') return
    member.muted = payload.muted
    io.to(voiceRoom(serverId, channel)).emit('voice:member-muted', { id: socket.id, muted: member.muted, serverId, channel })
  })

  socket.on('voice:video-mode', (payload) => {
    const serverId = socket.data.voiceServerId
    const channel = socket.data.voiceChannel
    const key = serverId && channel ? voiceRoomKey(serverId, channel) : null
    const member = key ? voiceMembers.get(key)?.get(socket.id) : undefined
    const videoMode = payload?.videoMode
    if (!serverId || !channel || !member
      || (videoMode !== null && videoMode !== 'camera' && videoMode !== 'screen')) return
    member.videoMode = videoMode
    io.to(voiceRoom(serverId, channel)).emit('voice:video-mode', {
      id: socket.id,
      videoMode,
      serverId,
      channel,
    })
  })

  socket.on('voice:speaking', (payload) => {
    const serverId = socket.data.voiceServerId
    const channel = socket.data.voiceChannel
    const key = serverId && channel ? voiceRoomKey(serverId, channel) : null
    const member = key ? voiceMembers.get(key)?.get(socket.id) : undefined
    if (!serverId || !channel || !member || typeof payload?.speaking !== 'boolean') return
    io.to(voiceRoom(serverId, channel)).emit('voice:speaking', {
      id: socket.id,
      speaking: payload.speaking && !member.muted,
      serverId,
      channel,
    })
  })

  socket.on('voice:signal', (payload) => {
    const serverId = socket.data.voiceServerId
    const channel = socket.data.voiceChannel
    const targetId = payload?.to
    const key = serverId && channel ? voiceRoomKey(serverId, channel) : null
    if (!serverId || typeof channel !== 'string' || payload?.serverId !== serverId || payload?.channel !== channel || typeof targetId !== 'string') return
    if (!voiceMembers.get(key)?.has(targetId)) return
    const signal = {}
    if (payload.description && ['offer', 'answer', 'rollback'].includes(payload.description.type)) {
      signal.description = payload.description
    }
    if (payload.candidate && typeof payload.candidate.candidate === 'string') {
      signal.candidate = payload.candidate
    }
    if (Object.keys(signal).length === 0) return
    io.to(targetId).emit('voice:signal', { from: socket.id, serverId, channel, ...signal })
  })

  socket.on('voice:leave', () => leaveVoice(socket))
  socket.on('disconnect', () => {
    leaveVoice(socket)
    for (const call of directCalls.values()) {
      if (call.callerSocketId === socket.id || call.calleeSocketId === socket.id) {
        finishDirectCall(call, call.status === 'ringing' ? 'missed' : 'ended')
      }
    }
    if (onlineMembers.delete(socket.id)) broadcastOnlineMembers()
  })
})

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.')
httpServer.listen(port, host, () => {
  console.log(`REFORM server listening at http://${host}:${port}`)
})
