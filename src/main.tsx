import * as React from 'react'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { Camera, ChevronDown, ChevronLeft, CircleHelp, Crown, Download, Gamepad2, Headphones, ImagePlus, LogOut, Maximize2, Menu, MessageCircle, Mic, MicOff, Paperclip, Phone, PhoneOff, Plus, ScreenShare, Search, Send, Settings, Sparkles, Swords, Trash2, Trophy, Users, Volume2, VolumeX, Wifi, X, Zap } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import './styles.css'

type AuthAccount = { id: string; email: string; username: string }
type ChatAttachment = { id: string; name: string; mimeType: string; size: number }
type ChatMessage = { id: string; serverId: string; channel: string; author: string; authorId?: string; avatarUrl?: string; content: string; attachments?: ChatAttachment[]; createdAt: string; kind?: 'welcome'; reactions?: Record<string, string[]> }
type DirectMessage = { id: string; fromId: string; fromName: string; toId: string; content: string; avatarUrl?: string; createdAt: string }
type DirectMessageStreak = { streak: number; activeToday: boolean; lastSharedDay: string | null }
type OnlineMember = { id: string; name: string; avatarUrl?: string }
type Friend = OnlineMember & { online: boolean }
type DirectConversationSummary = { contact: OnlineMember; lastMessage: DirectMessage | null; streak: DirectMessageStreak }
type DirectContact = OnlineMember & { online: boolean; streak?: DirectMessageStreak; lastMessage?: DirectMessage | null }
type DirectCall = {
  id: string
  contactId: string
  contactName: string
  direction: 'incoming' | 'outgoing'
  status: 'starting' | 'ringing' | 'connecting' | 'active'
  peerSocketId?: string
}
type TextChannelDefinition = { label: string; topic: string; count?: number; createdBy?: string }
type VoiceChannelDefinition = { label: string }
type ServerDefinition = { id: string; name: string; ownerId?: string | null; textChannels: TextChannelDefinition[]; voiceChannels: VoiceChannelDefinition[] }
type ChannelLists = { serverId: string; textChannels: TextChannelDefinition[]; voiceChannels: VoiceChannelDefinition[] }
type VoiceMembers = { serverId: string; channel: string; members: string[] }
type VoicePeer = { id: string; userId?: string; author: string; muted: boolean; speaking?: boolean; videoMode?: 'camera' | 'screen' | null }
type VoiceRoster = { serverId: string; channel: string; peers: VoicePeer[] }
type VoiceSignal = { serverId: string; channel: string; from: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
type ProgressState = {
  dayKey: string
  weekKey: string
  dailySignIn: boolean
  dailyMessages: number
  dailyReactions: number
  dailyVoiceJoins: number
  weeklyMessages: number
  weeklyReactions: number
  weeklyVoiceDays: string[]
  claimed: string[]
  xp: number
}

function getProgressPeriod(now = new Date()) {
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  return { dayKey, weekKey }
}

function createProgressState(): ProgressState {
  const { dayKey, weekKey } = getProgressPeriod()
  return { dayKey, weekKey, dailySignIn: false, dailyMessages: 0, dailyReactions: 0, dailyVoiceJoins: 0, weeklyMessages: 0, weeklyReactions: 0, weeklyVoiceDays: [], claimed: [], xp: 0 }
}

function getSavedServerId() {
  try {
    return localStorage.getItem('reform-active-server') ?? 'reform'
  } catch {
    return 'reform'
  }
}

function normalizeProfilePicture(data: string) {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(data)
  if (!match) throw new Error('The saved profile picture is not a supported image.')
  const bytes = atob(match[1])
  const detectedType = bytes.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
    : bytes.startsWith('\xff\xd8\xff') ? 'image/jpeg'
      : bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a') ? 'image/gif'
        : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP' ? 'image/webp'
          : null
  if (!detectedType) throw new Error('Use a PNG, JPEG, GIF, or WebP profile picture.')
  return `data:${detectedType};base64,${match[1]}`
}

function getRtcConfiguration(): RTCConfiguration {
  const configuredServers = import.meta.env.VITE_RTC_ICE_SERVERS
  if (!configuredServers) return { iceServers: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(configuredServers)
  } catch {
    throw new Error('VITE_RTC_ICE_SERVERS must contain a valid JSON array.')
  }
  if (!Array.isArray(parsed) || parsed.some((server) => {
    if (typeof server !== 'object' || server === null) return true
    const urls = Reflect.get(server, 'urls')
    return !(typeof urls === 'string' || (Array.isArray(urls) && urls.every((url) => typeof url === 'string')))
  })) {
    throw new Error('VITE_RTC_ICE_SERVERS must be an array of ICE server objects with urls.')
  }
  return { iceServers: parsed }
}

const channels = [
  { label: 'lobby', topic: 'Find your squad. Share your wins.', count: 0 },
  { label: 'looking-for-group', topic: 'Find teammates for your next run.', count: 0 },
  { label: 'game-clips', topic: 'Post your best plays and moments.', count: 0 },
  { label: 'strategy-lab', topic: 'Build theory, share the tech.', count: 0 },
]

const voiceChannels = [
  { label: 'Moonbase' },
  { label: 'Boss Rush' },
]
const defaultServer: ServerDefinition = { id: 'reform', name: 'REFORM', textChannels: channels, voiceChannels }
const serverColors = ['#5a4a91', '#955b3c', '#387c77', '#76513f', '#3c6894']
const maxAttachmentSize = 5 * 1024 * 1024
const attachmentLimit = 4
const voiceRoomKey = (serverId: string, channel: string) => `${serverId}:${channel}`

function AuthGate() {
  const [account, setAccount] = useState<AuthAccount | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !(event.target instanceof Element)) return
      const button = event.target.closest('button')
      if (!(button instanceof HTMLButtonElement) || button.disabled) return
      const bounds = button.getBoundingClientRect()
      button.style.setProperty('--ripple-x', `${event.clientX - bounds.left}px`)
      button.style.setProperty('--ripple-y', `${event.clientY - bounds.top}px`)
      button.classList.remove('is-rippling')
      void button.offsetWidth
      button.classList.add('is-rippling')
    }
    const clearRipple = (event: AnimationEvent) => {
      if (event.animationName === 'button-ripple' && event.target instanceof HTMLButtonElement) {
        event.target.classList.remove('is-rippling')
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('animationend', clearRipple, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('animationend', clearRipple, true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then(async (response) => {
        if (response.status === 401) return null
        const result = await response.json() as { account?: AuthAccount; error?: string }
        if (!response.ok) throw new Error(result.error ?? 'Could not check your sign-in.')
        if (!result.account || typeof result.account.id !== 'string' || typeof result.account.email !== 'string' || typeof result.account.username !== 'string') {
          throw new Error('The server returned an invalid account.')
        }
        return result.account
      })
      .then((savedAccount) => {
        if (!cancelled) {
          setAccount(savedAccount)
          setSessionError('')
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setSessionError(error.message || 'Could not connect to REFORM. Start the backend and try again.')
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => { cancelled = true }
  }, [])

  const signOut = async () => {
    const response = await fetch('/api/auth/logout', { method: 'POST' })
    if (!response.ok) throw new Error('Could not sign out. Please try again.')
    setAccount(null)
  }

  if (checkingSession) {
    return <main className="auth-screen" aria-busy="true"><div className="auth-card auth-loading"><div className="brand-mark">R<span>×</span></div><span>Connecting to REFORM…</span></div></main>
  }
  if (!account) return <AuthScreen initialError={sessionError} onAuthenticated={setAccount} />
  return <App key={account.id} user={account} onProfileUpdate={setAccount} onSignOut={signOut} />
}

function AuthScreen({ initialError, onAuthenticated }: { initialError: string; onAuthenticated: (account: AuthAccount) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [username, setUsername] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)
  const passwordRequirements = [
    { label: '12 characters', met: password.length >= 12 },
    { label: 'Uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', met: /[a-z]/.test(password) },
    { label: 'Number', met: /\d/.test(password) },
    { label: 'Symbol', met: /[^A-Za-z0-9]/.test(password) },
  ]
  const passwordIsStrong = passwordRequirements.every(({ met }) => met)
  const passwordsMatch = password === passwordConfirmation

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mode === 'register' && !passwordIsStrong) {
      setError('Choose a strong password that meets every requirement.')
      return
    }
    if (mode === 'register' && !passwordsMatch) {
      setError('Your passwords do not match.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ...(mode === 'register' ? { username, passwordConfirmation } : {}) }),
      })
      const result = await response.json() as { account?: AuthAccount; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Sign-in failed. Please try again.')
      if (!result.account || typeof result.account.id !== 'string' || typeof result.account.email !== 'string' || typeof result.account.username !== 'string') {
        throw new Error('The server returned an invalid account.')
      }
      onAuthenticated(result.account)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not connect to REFORM. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-screen">
      <section key={mode} className={`auth-card ${submitting ? 'auth-submitting' : ''}`} aria-labelledby="auth-title" aria-busy={submitting}>
        <div className="auth-brand"><div className="brand-mark auth-logo-mark"><span className="auth-logo-r">R</span><span className="auth-logo-x">×</span></div><span>REFORM</span></div>
        <div className="auth-heading"><div className="auth-icon"><Gamepad2 size={20} /></div><p className="eyebrow">YOUR SQUAD IS WAITING</p><h1 id="auth-title">{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1><span>{mode === 'login' ? 'Sign in to jump back into your communities.' : 'Set up your REFORM player profile to get started.'}</span></div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === 'register' && <label>Username<input autoComplete="username" required minLength={1} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="How your squad knows you" disabled={submitting} /></label>}
          <label>Email<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={submitting} /></label>
          <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 12 : 1} maxLength={128} value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} placeholder={mode === 'register' ? 'Create a strong password' : 'Your password'} disabled={submitting} /></label>
          {mode === 'register' && <><div className="password-strength" aria-live="polite"><div className="password-strength-heading"><span>Password strength</span><strong className={passwordIsStrong ? 'password-strong' : ''}>{passwordIsStrong ? 'Strong' : password ? 'Keep going' : 'Not set'}</strong></div><div className="password-strength-track"><span className={passwordIsStrong ? 'password-strength-full' : ''} style={{ width: `${passwordRequirements.filter(({ met }) => met).length / passwordRequirements.length * 100}%` }} /></div><ul>{passwordRequirements.map(({ label, met }) => <li className={met ? 'password-rule-met' : ''} key={label}><span aria-hidden="true">{met ? '✓' : '○'}</span>{label}</li>)}</ul></div><label>Confirm password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={passwordConfirmation} onChange={(event) => { setPasswordConfirmation(event.target.value); setError('') }} placeholder="Enter your password again" disabled={submitting} />{passwordConfirmation && !passwordsMatch && <span className="auth-field-error">Passwords do not match.</span>}</label></>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className={`auth-submit ${submitting ? 'auth-submit-loading' : ''}`} type="submit" disabled={submitting || (mode === 'register' && (!passwordIsStrong || !passwordsMatch || !passwordConfirmation))}>{submitting ? <><span className="auth-submit-spinner" aria-hidden="true" />{mode === 'login' ? 'Signing in…' : 'Creating account…'}</> : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="auth-switch">{mode === 'login' ? 'New to REFORM?' : 'Already have an account?'} <button type="button" onClick={() => { setMode((current) => current === 'login' ? 'register' : 'login'); setError('') }} disabled={submitting}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
        <p className="auth-password-note">Passwords are securely hashed. Never reuse a password you use elsewhere.</p>
      </section>
    </main>
  )
}

function App({ user, onProfileUpdate, onSignOut }: { user: AuthAccount; onProfileUpdate: (account: AuthAccount) => void; onSignOut: () => Promise<void> }) {
  const memberWelcomeSent = useRef(false)
  const [socket, setSocket] = useState<Socket | null>(null)
  const [backendOnline, setBackendOnline] = useState(false)
  const [servers, setServers] = useState<ServerDefinition[]>([])
  const serversRef = useRef(servers)
  serversRef.current = servers
  const [activeServerId, setActiveServerId] = useState(getSavedServerId)
  const [activeChannel, setActiveChannel] = useState('welcome')
  const [textChannelList, setTextChannelList] = useState<TextChannelDefinition[]>(channels)
  const [voiceChannelList, setVoiceChannelList] = useState<VoiceChannelDefinition[]>(voiceChannels)
  const [channelCreationType, setChannelCreationType] = useState<'text' | 'voice' | null>(null)
  const [serverEntryOpen, setServerEntryOpen] = useState(() => Boolean(new URLSearchParams(window.location.search).get('invite')))
  const [inviteCodeDraft, setInviteCodeDraft] = useState(() => new URLSearchParams(window.location.search).get('invite') ?? '')
  const [isJoiningServer, setIsJoiningServer] = useState(false)
  const [inviteDialogServer, setInviteDialogServer] = useState<ServerDefinition | null>(null)
  const [serverInviteCode, setServerInviteCode] = useState('')
  const [isLoadingInvite, setIsLoadingInvite] = useState(false)
  const [serverDialogMode, setServerDialogMode] = useState<'create' | 'rename' | null>(null)
  const [serverDeleteTarget, setServerDeleteTarget] = useState<ServerDefinition | null>(null)
  const [isDeletingServer, setIsDeletingServer] = useState(false)
  const [serverNameDraft, setServerNameDraft] = useState('')
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [isSavingServer, setIsSavingServer] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelTopic, setNewChannelTopic] = useState('')
  const [isCreatingChannel, setIsCreatingChannel] = useState(false)
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<{ serverId: string; channel: TextChannelDefinition } | null>(null)
  const [channelNameDraft, setChannelNameDraft] = useState('')
  const [isSavingChannelSettings, setIsSavingChannelSettings] = useState(false)
  const [confirmChannelDelete, setConfirmChannelDelete] = useState(false)
  const [isSavingProfileName, setIsSavingProfileName] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [communityTab, setCommunityTab] = useState<'leaderboard' | 'quests' | null>(null)
  const [activeVoice, setActiveVoice] = useState<string | null>(null)
  const [voiceStageOpen, setVoiceStageOpen] = useState(false)
  const [pipPosition, setPipPosition] = useState<{ left: number; top: number } | null>(null)
  const pipDragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null)
  const pipDraggedRef = useRef(false)
  const [pinnedVoicePeerId, setPinnedVoicePeerId] = useState<string | null>(null)
  const [voiceMembers, setVoiceMembers] = useState<Record<string, string[]>>({})
  const [profileName, setProfileName] = useState(user.username)
  const [profileNameDraft, setProfileNameDraft] = useState(user.username)
  const [onlineMembers, setOnlineMembers] = useState<OnlineMember[]>([])
  const [friends, setFriends] = useState<Friend[]>([])
  const [friendActionPending, setFriendActionPending] = useState<string | null>(null)
  const [dmSummaries, setDmSummaries] = useState<DirectConversationSummary[]>([])
  const [directMessagesOpen, setDirectMessagesOpen] = useState(false)
  const [activeDmContact, setActiveDmContact] = useState<DirectContact | null>(null)
  const [directCall, setDirectCall] = useState<DirectCall | null>(null)
  const directCallRef = useRef<DirectCall | null>(directCall)
  directCallRef.current = directCall
  const directCallStreamRef = useRef<MediaStream | null>(null)
  const directCallStreamIdRef = useRef<string | null>(null)
  const [isDirectCallMuted, setIsDirectCallMuted] = useState(false)
  const directCallRequestRef = useRef(0)
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([])
  const [directMessageStreak, setDirectMessageStreak] = useState<DirectMessageStreak>({ streak: 0, activeToday: false, lastSharedDay: null })
  const [directMessageDraft, setDirectMessageDraft] = useState('')
  const [isSendingDirectMessage, setIsSendingDirectMessage] = useState(false)
  const [voicePeers, setVoicePeers] = useState<VoicePeer[]>([])
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [channelToolsOpen, setChannelToolsOpen] = useState(false)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState('')
  const [selectedOutputId, setSelectedOutputId] = useState('')
  const [micVolume, setMicVolume] = useState(100)
  const [outputVolume, setOutputVolume] = useState(100)
  const [videoMode, setVideoMode] = useState<'camera' | 'screen' | null>(null)
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null)
  const [profilePicture, setProfilePicture] = useState<string | null>(null)
  const [profilePictureLoaded, setProfilePictureLoaded] = useState(false)
  const [viewedProfile, setViewedProfile] = useState<string | null>(null)
  const [viewedAccount, setViewedAccount] = useState<DirectContact | null>(null)
  const [isLoadingViewedAccount, setIsLoadingViewedAccount] = useState(false)
  const profileLookupSequence = useRef(0)
  const [voiceSignal, setVoiceSignal] = useState<'unknown' | 'weak' | 'fair' | 'strong'>('unknown')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [message, setMessage] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([])
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const [progress, setProgress] = useState<ProgressState>(() => {
    try {
      const saved = localStorage.getItem(`reform-progression-v2-${user.id}`)
      if (!saved) return createProgressState()
      const parsed = JSON.parse(saved) as Partial<ProgressState>
      const defaults = createProgressState()
      const { dayKey, weekKey } = defaults
      return {
        ...defaults,
        ...parsed,
        dayKey,
        weekKey,
        dailySignIn: parsed.dayKey === dayKey && parsed.dailySignIn === true,
        dailyMessages: parsed.dayKey === dayKey ? parsed.dailyMessages ?? 0 : 0,
        dailyReactions: parsed.dayKey === dayKey ? parsed.dailyReactions ?? 0 : 0,
        dailyVoiceJoins: parsed.dayKey === dayKey ? parsed.dailyVoiceJoins ?? 0 : 0,
        weeklyMessages: parsed.weekKey === weekKey ? parsed.weeklyMessages ?? 0 : 0,
        weeklyReactions: parsed.weekKey === weekKey ? parsed.weeklyReactions ?? 0 : 0,
        weeklyVoiceDays: parsed.weekKey === weekKey ? parsed.weeklyVoiceDays ?? [] : [],
        claimed: (parsed.claimed ?? []).filter((claim) => claim.startsWith(`${dayKey}:`) || claim.startsWith(`${weekKey}:`)),
        xp: Number.isFinite(parsed.xp) ? Math.max(0, parsed.xp ?? 0) : 0,
      }
    } catch {
      return createProgressState()
    }
  })
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null)
  const [reactionPickerPosition, setReactionPickerPosition] = useState<{ top: number; left: number } | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [notice, setNoticeMessage] = useState('')
  const [noticeSequence, setNoticeSequence] = useState(0)
  const [voiceJoinNotice, setVoiceJoinNotice] = useState('')
  const activeVoiceRef = useRef<string | null>(null)
  const activeVoiceServerRef = useRef<string | null>(null)
  const disconnectVoiceRef = useRef<() => void>(() => {})
  const activeServerIdRef = useRef(activeServerId)
  const activeChannelRef = useRef(activeChannel)
  activeChannelRef.current = activeChannel
  const profileNameRef = useRef(profileName)
  profileNameRef.current = profileName
  const activeDmContactRef = useRef(activeDmContact)
  activeDmContactRef.current = activeDmContact
  const deafenedRef = useRef(false)
  const voiceAudioContext = useRef<AudioContext | null>(null)
  const notificationAudioContext = useRef<AudioContext | null>(null)
  const micSourceNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const micGainNode = useRef<GainNode | null>(null)
  const outgoingAudioStream = useRef<MediaStream | null>(null)
  const localVideoStreamRef = useRef<MediaStream | null>(null)
  const voiceJoinNoticeTimer = useRef<number | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const localStream = useRef<MediaStream | null>(null)
  const micSwitchRequest = useRef(0)
  const localSpeaking = useRef(false)
  const peerConnections = useRef(new Map<string, RTCPeerConnection>())
  const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>())
  const makingOffer = useRef(new Set<string>())
  const ignoreOffer = useRef(new Set<string>())
  const reactionUserId = useRef('')
  const notifiedChatMessageIds = useRef(new Set<string>())
  const profilePictureSync = useRef<{ data: string; promise: Promise<void> } | null>(null)

  const reactionPickerRef = useRef<HTMLDivElement | null>(null)
  const reactionPickerTriggerRef = useRef<HTMLButtonElement | null>(null)

  const playNotificationSound = () => {
    const context = notificationAudioContext.current
    if (!context || context.state !== 'running') return
    const now = context.currentTime
    const master = context.createGain()
    master.gain.setValueAtTime(0.0001, now)
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.008)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    master.connect(context.destination)
    for (const [frequency, start, duration] of [[880, 0, 0.14], [1174.66, 0.1, 0.19]] as const) {
      const oscillator = context.createOscillator()
      const tone = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, now + start)
      tone.gain.setValueAtTime(0.0001, now + start)
      tone.gain.exponentialRampToValueAtTime(1, now + start + 0.008)
      tone.gain.exponentialRampToValueAtTime(0.0001, now + start + duration)
      oscillator.connect(tone)
      tone.connect(master)
      oscillator.start(now + start)
      oscillator.stop(now + start + duration + 0.02)
    }
  }

  useEffect(() => {
    const unlockNotificationAudio = () => {
      try {
        if (!notificationAudioContext.current || notificationAudioContext.current.state === 'closed') {
          notificationAudioContext.current = new AudioContext()
        }
        if (notificationAudioContext.current.state === 'suspended') {
          void notificationAudioContext.current.resume().catch((error: unknown) => {
            console.warn('Could not enable notification sounds:', error)
          })
        }
      } catch (error) {
        console.warn('Could not enable notification sounds:', error)
      }
    }
    document.addEventListener('pointerdown', unlockNotificationAudio, { capture: true, once: true })
    document.addEventListener('keydown', unlockNotificationAudio, { capture: true, once: true })
    return () => {
      document.removeEventListener('pointerdown', unlockNotificationAudio, { capture: true })
      document.removeEventListener('keydown', unlockNotificationAudio, { capture: true })
      if (notificationAudioContext.current && notificationAudioContext.current.state !== 'closed') {
        void notificationAudioContext.current.close()
        notificationAudioContext.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!directCall || directCall.status !== 'ringing') return
    playNotificationSound()
    const ringTimer = window.setInterval(playNotificationSound, 1500)
    return () => window.clearInterval(ringTimer)
  }, [directCall?.id, directCall?.status])

  const setNotice = (nextNotice: string) => {
    if (nextNotice) playNotificationSound()
    setNoticeMessage(nextNotice)
    setNoticeSequence((sequence) => sequence + 1)
  }

  const updateProgress = (update: (current: ProgressState) => ProgressState) => {
    setProgress((current) => update(current))
  }

  const recordChatProgress = () => {
    updateProgress((current) => ({ ...current, dailyMessages: current.dailyMessages + 1, weeklyMessages: current.weeklyMessages + 1 }))
  }

  const recordReactionProgress = (messageId: string, emoji: string, reactions: Record<string, string[]>) => {
    if (!reactions[emoji]?.includes(reactionUserId.current)) return
    const key = `reform-reacted-${getProgressPeriod().dayKey}`
    try {
      const alreadyReacted = JSON.parse(localStorage.getItem(key) ?? '[]') as string[]
      if (alreadyReacted.includes(messageId)) return
      localStorage.setItem(key, JSON.stringify([...alreadyReacted, messageId]))
    } catch (error) {
      setNotice(`Could not save reaction quest progress: ${error instanceof Error ? error.message : 'storage unavailable'}`)
    }
    updateProgress((current) => ({ ...current, dailyReactions: current.dailyReactions + 1, weeklyReactions: current.weeklyReactions + 1 }))
  }

  const createOutgoingAudioStream = (input: MediaStream) => {
    const context = voiceAudioContext.current
    if (!context) throw new Error('Voice audio is not initialized.')
    const source = context.createMediaStreamSource(input)
    const gain = context.createGain()
    const destination = context.createMediaStreamDestination()
    gain.gain.value = micVolume / 100
    source.connect(gain)
    gain.connect(destination)
    micSourceNode.current = source
    micGainNode.current = gain
    outgoingAudioStream.current = destination.stream
    return destination.stream
  }

  const replaceVideoTrack = async (stream: MediaStream | null) => {
    const track = stream?.getVideoTracks()[0] ?? null
    await Promise.all([...peerConnections.current.values()].map(async (peer) => {
      const transceiver = peer.getTransceivers().find((item) => item.receiver.track.kind === 'video')
      if (!transceiver) return
      await transceiver.sender.replaceTrack(track)
      transceiver.direction = track ? 'sendrecv' : 'recvonly'
    }))
    if (localVideoStreamRef.current && localVideoStreamRef.current !== stream) {
      localVideoStreamRef.current.getTracks().forEach((oldTrack) => oldTrack.stop())
    }
    localVideoStreamRef.current = stream
    setLocalVideoStream(stream)
  }

  const enumerateAudioDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setAudioInputs(devices.filter((device) => device.kind === 'audioinput'))
      setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'))
    } catch (error) {
      setNotice(`Could not list audio devices: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const playVoiceJoinSound = () => {
    const context = voiceAudioContext.current
    if (!context || context.state !== 'running' || deafenedRef.current) return
    const now = context.currentTime
    const master = context.createGain()
    master.gain.setValueAtTime(0.0001, now)
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.012)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.42)
    master.connect(context.destination)

    for (const [frequency, start, duration] of [[880, 0, 0.2], [1174.66, 0.12, 0.28]] as const) {
      const oscillator = context.createOscillator()
      const tone = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, now + start)
      tone.gain.setValueAtTime(0.0001, now + start)
      tone.gain.exponentialRampToValueAtTime(1, now + start + 0.01)
      tone.gain.exponentialRampToValueAtTime(0.0001, now + start + duration)
      oscillator.connect(tone)
      tone.connect(master)
      oscillator.start(now + start)
      oscillator.stop(now + start + duration + 0.02)
    }
  }

  const showVoiceJoinNotice = (author: string) => {
    setVoiceJoinNotice(`${author} joined ${activeVoiceRef.current ?? 'voice'}`)
    if (voiceJoinNoticeTimer.current !== null) window.clearTimeout(voiceJoinNoticeTimer.current)
    voiceJoinNoticeTimer.current = window.setTimeout(() => {
      setVoiceJoinNotice('')
      voiceJoinNoticeTimer.current = null
    }, 3600)
  }

  const showNativeVoiceNotification = (author: string, channel: string) => {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return
    try {
      const notification = new Notification('Voice lounge', { body: `${author} joined ${channel}.` })
      notification.onclick = () => {
        window.focus()
        setVoiceStageOpen(true)
        notification.close()
      }
    } catch (error) {
      console.warn('Could not show native voice notification:', error)
    }
  }

  const ensurePeerConnection = (peerId: string, connection: Socket, serverId: string, channel: string) => {
    const existing = peerConnections.current.get(peerId)
    if (existing) return existing

    const peer = new RTCPeerConnection(getRtcConfiguration())
    peerConnections.current.set(peerId, peer)
    const stream = outgoingAudioStream.current
    stream?.getAudioTracks().forEach((track) => peer.addTrack(track, stream))
    const videoTrack = localVideoStreamRef.current?.getVideoTracks()[0]
    const videoTransceiver = peer.addTransceiver('video', { direction: videoTrack ? 'sendrecv' : 'recvonly' })
    if (videoTrack) void videoTransceiver.sender.replaceTrack(videoTrack)
    peer.onnegotiationneeded = async () => {
      if (peer.signalingState !== 'stable') return
      try {
        makingOffer.current.add(peerId)
        await peer.setLocalDescription()
        if (peer.localDescription) {
          connection.emit('voice:signal', { to: peerId, serverId, channel, description: peer.localDescription })
        }
      } catch (error) {
        setNotice(`Could not negotiate voice media: ${error instanceof Error ? error.message : 'unknown error'}`)
      } finally {
        makingOffer.current.delete(peerId)
      }
    }
    peer.onicecandidate = (event) => {
      if (event.candidate) connection.emit('voice:signal', { to: peerId, serverId, channel, candidate: event.candidate.toJSON() })
    }
    peer.ontrack = (event) => {
      setRemoteStreams((current) => {
        const tracks = current[peerId]?.getTracks() ?? []
        if (tracks.some((track) => track.id === event.track.id)) return current
        return { ...current, [peerId]: new MediaStream([...tracks, event.track]) }
      })
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') {
        setNotice('Voice connection failed. Check the network and ICE/TURN server settings.')
      }
    }
    return peer
  }

  const disposeDirectCallMedia = (callId: string) => {
    const peerId = `dm-call:${callId}`
    peerConnections.current.get(peerId)?.close()
    peerConnections.current.delete(peerId)
    pendingCandidates.current.delete(peerId)
    makingOffer.current.delete(peerId)
    ignoreOffer.current.delete(peerId)
    setRemoteStreams((current) => {
      if (!current[peerId]) return current
      const next = { ...current }
      delete next[peerId]
      return next
    })
    if (directCallStreamIdRef.current === callId) {
      directCallStreamRef.current?.getTracks().forEach((track) => track.stop())
      directCallStreamRef.current = null
      directCallStreamIdRef.current = null
      setIsDirectCallMuted(false)
    }
  }

  const clearDirectCall = (callId: string) => {
    disposeDirectCallMedia(callId)
    if (directCallRef.current?.id === callId) {
      directCallRef.current = null
      setDirectCall(null)
    }
  }

  const ensureDirectCallPeerConnection = (callId: string, peerSocketId: string, shouldOffer: boolean, connection: Socket) => {
    const peerId = `dm-call:${callId}`
    const existing = peerConnections.current.get(peerId)
    if (existing) return existing

    const peer = new RTCPeerConnection(getRtcConfiguration())
    peerConnections.current.set(peerId, peer)
    directCallStreamRef.current?.getAudioTracks().forEach((track) => peer.addTrack(track, directCallStreamRef.current!))
    peer.onnegotiationneeded = async () => {
      if (!shouldOffer || peer.signalingState !== 'stable') return
      try {
        makingOffer.current.add(peerId)
        await peer.setLocalDescription()
        if (peer.localDescription) {
          connection.emit('dm-call:signal', { callId, to: peerSocketId, description: peer.localDescription })
        }
      } catch (error) {
        setNotice(`Could not start the direct call: ${error instanceof Error ? error.message : 'unknown error'}`)
      } finally {
        makingOffer.current.delete(peerId)
      }
    }
    peer.onicecandidate = (event) => {
      if (event.candidate) connection.emit('dm-call:signal', { callId, to: peerSocketId, candidate: event.candidate.toJSON() })
    }
    peer.ontrack = (event) => {
      setRemoteStreams((current) => {
        const tracks = current[peerId]?.getTracks() ?? []
        if (tracks.some((track) => track.id === event.track.id)) return current
        return { ...current, [peerId]: new MediaStream([...tracks, event.track]) }
      })
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setDirectCall((current) => current?.id === callId ? { ...current, status: 'active' } : current)
      } else if (peer.connectionState === 'failed') {
        setNotice('The direct call could not connect. Check the network and ICE/TURN server settings.')
        socket?.emit('dm-call:end', { callId })
        clearDirectCall(callId)
      }
    }
    return peer
  }

  useEffect(() => {
    if (!mobileSidebarOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileSidebarOpen])

  useEffect(() => {
    reactionUserId.current = user.id
    const connection = io()
    setSocket(connection)
    const syncServerList = (nextServers: ServerDefinition[]) => {
      if (!Array.isArray(nextServers) || !nextServers.every((server) => typeof server?.id === 'string' && typeof server.name === 'string'
        && Array.isArray(server.textChannels) && Array.isArray(server.voiceChannels))) {
        setNotice('The server returned an invalid server list.')
        return
      }
      const nextServerIds = new Set(nextServers.map(({ id }) => id))
      const removedServerIds = new Set(serversRef.current.filter(({ id }) => !nextServerIds.has(id)).map(({ id }) => id))
      if (removedServerIds.size > 0) {
        setChatMessages((current) => current.filter(({ serverId }) => !removedServerIds.has(serverId)))
        setVoiceMembers((current) => Object.fromEntries(Object.entries(current)
          .filter(([key]) => ![...removedServerIds].some((serverId) => key.startsWith(`${serverId}:`)))))
      }
      serversRef.current = nextServers
      setServers(nextServers)
      const previousServerId = activeServerIdRef.current
      let selectedServerId = previousServerId
      if (!nextServers.some((server) => server.id === selectedServerId)) selectedServerId = nextServers[0]?.id ?? ''
      if (selectedServerId !== previousServerId && activeVoiceServerRef.current === previousServerId) {
        disconnectVoiceRef.current()
      }
      activeServerIdRef.current = selectedServerId
      setActiveServerId(selectedServerId)
      const selectedServer = nextServers.find((server) => server.id === selectedServerId)
      if (selectedServer) {
        setTextChannelList(selectedServer.textChannels.filter(({ label }) => label !== 'welcome'))
        setVoiceChannelList(selectedServer.voiceChannels)
        const currentChannel = activeChannelRef.current
        const currentVoiceChat = currentChannel.startsWith('voice:') ? currentChannel.slice('voice:'.length) : null
        if (!selectedServer.textChannels.some(({ label }) => label === currentChannel)
          && !(currentVoiceChat && selectedServer.voiceChannels.some(({ label }) => label === currentVoiceChat))) {
          activeChannelRef.current = 'welcome'
          setActiveChannel('welcome')
        }
      } else {
        setTextChannelList([])
        setVoiceChannelList([])
        activeChannelRef.current = 'welcome'
        setActiveChannel('welcome')
      }
    }
    const syncChannelLists = (lists: ChannelLists) => {
      if (!Array.isArray(lists?.textChannels) || !Array.isArray(lists?.voiceChannels)) {
        setNotice('The server returned an invalid channel list.')
        return
      }
      setServers((current) => current.map((server) => server.id === lists.serverId
        ? { ...server, textChannels: lists.textChannels, voiceChannels: lists.voiceChannels }
        : server))
      if (lists.serverId !== activeServerIdRef.current) return
      setTextChannelList(lists.textChannels.filter(({ label }) => label !== 'welcome'))
      setVoiceChannelList(lists.voiceChannels)
    }
    const syncOnlineMembers = (members: OnlineMember[]) => {
      if (!Array.isArray(members) || !members.every((member) => typeof member?.id === 'string' && typeof member.name === 'string')) {
        setNotice('The server returned an invalid member list.')
        return
      }
      setOnlineMembers(members)
    }
    const syncDirectConversations = () => {
      fetch(`/api/dms/${encodeURIComponent(reactionUserId.current)}`)
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not load direct conversations.')
          return response.json() as Promise<{ conversations: DirectConversationSummary[] }>
        })
        .then(({ conversations }) => setDmSummaries(conversations))
        .catch((error: Error) => setNotice(error.message))
    }
    const syncFriends = () => {
      fetch('/api/friends')
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not load your friends list.')
          return response.json() as Promise<{ friends: Friend[] }>
        })
        .then(({ friends: loadedFriends }) => {
          if (!Array.isArray(loadedFriends) || !loadedFriends.every((friend) => typeof friend?.id === 'string'
            && typeof friend.name === 'string' && typeof friend.online === 'boolean')) {
            throw new Error('The server returned an invalid friends list.')
          }
          setFriends(loadedFriends)
        })
        .catch((error: Error) => setNotice(error.message))
    }
    connection.on('servers:list', syncServerList)
    connection.on('servers:updated', syncServerList)
    connection.on('channels:list', syncChannelLists)
    connection.on('channels:updated', syncChannelLists)
    connection.on('channel:renamed', ({ serverId, previousLabel, label }: { serverId: string; previousLabel: string; label: string }) => {
      if (typeof serverId !== 'string' || typeof previousLabel !== 'string' || typeof label !== 'string') {
        setNotice('The server sent invalid text channel rename details.')
        return
      }
      setChatMessages((current) => current.map((message) =>
        message.serverId === serverId && message.channel === previousLabel ? { ...message, channel: label } : message))
      if (activeServerIdRef.current === serverId && activeChannelRef.current === previousLabel) {
        activeChannelRef.current = label
        setActiveChannel(label)
      }
    })
    connection.on('channel:deleted', ({ serverId, label }: { serverId: string; label: string }) => {
      if (typeof serverId !== 'string' || typeof label !== 'string') {
        setNotice('The server sent invalid text channel deletion details.')
        return
      }
      setChatMessages((current) => current.filter((message) => message.serverId !== serverId || message.channel !== label))
      if (activeServerIdRef.current === serverId && activeChannelRef.current === label) {
        activeChannelRef.current = 'welcome'
        setActiveChannel('welcome')
        setCommunityTab(null)
        setNotice(`#${label} was deleted. Its chat history was removed.`)
      }
    })
    connection.on('members:list', syncOnlineMembers)
    connection.on('friend:added', ({ member }: { member: Friend }) => {
      if (typeof member?.id !== 'string' || typeof member.name !== 'string' || typeof member.online !== 'boolean') {
        setNotice('The server sent an invalid friend notification.')
        return
      }
      setFriends((current) => current.some(({ id }) => id === member.id)
        ? current.map((friend) => friend.id === member.id ? member : friend)
        : [...current, member])
      setNotice(`${member.name} added you as a friend.`)
    })
    connection.on('dm:notification', ({ fromId, fromName, content }: { fromId: string; fromName: string; content: string }) => {
      if (typeof fromId !== 'string' || typeof fromName !== 'string' || typeof content !== 'string') {
        setNotice('The server sent an invalid message notification.')
        return
      }
      if (activeDmContactRef.current?.id === fromId) return
      const preview = content.length > 90 ? `${content.slice(0, 87)}…` : content
      setNotice(`New message from ${fromName}: ${preview}`)
    })
    connection.on('dm:message', ({ message: directMessage, streak }: { conversationId: string; message: DirectMessage; streak: DirectMessageStreak }) => {
      const contactId = directMessage.fromId === reactionUserId.current ? directMessage.toId : directMessage.fromId
      if (activeDmContactRef.current?.id === contactId) {
        setDirectMessages((current) => current.some((item) => item.id === directMessage.id) ? current : [...current, directMessage])
        setDirectMessageStreak(streak)
      }
      syncDirectConversations()
    })
    connection.on('dm-call:incoming', ({ callId, fromId, fromName }: { callId: string; fromId: string; fromName: string }) => {
      if (typeof callId !== 'string' || typeof fromId !== 'string' || typeof fromName !== 'string') {
        setNotice('The server sent invalid direct-call details.')
        return
      }
      setDirectCall((current) => {
        if (current) return current
        return { id: callId, contactId: fromId, contactName: fromName, direction: 'incoming', status: 'ringing' }
      })
    })
    connection.on('dm-call:accepted', ({ callId, peerSocketId }: { callId: string; peerSocketId: string }) => {
      if (typeof callId !== 'string' || typeof peerSocketId !== 'string') {
        setNotice('The server sent invalid direct-call connection details.')
        return
      }
      const currentCall = directCallRef.current
      if (!currentCall || currentCall.id !== callId || !directCallStreamRef.current) return
      const nextCall = { ...currentCall, peerSocketId, status: 'connecting' as const }
      directCallRef.current = nextCall
      setDirectCall(nextCall)
      ensureDirectCallPeerConnection(callId, peerSocketId, currentCall.direction === 'outgoing', connection)
    })
    connection.on('dm-call:answered-elsewhere', ({ callId }: { callId: string }) => {
      if (directCallRef.current?.id !== callId) return
      clearDirectCall(callId)
    })
    connection.on('dm-call:ended', ({ callId, reason }: { callId: string; reason: string }) => {
      const currentCall = directCallRef.current
      if (!currentCall || currentCall.id !== callId) return
      clearDirectCall(callId)
      if (reason === 'declined') setNotice(`${currentCall.contactName} declined the call.`)
      else if (reason === 'missed') setNotice(`${currentCall.contactName} missed the call.`)
      else if (reason === 'cancelled') setNotice('The call was cancelled.')
      else if (reason === 'ended') setNotice('The call ended.')
    })
    connection.on('dm-call:signal', async ({ callId, from, description, candidate }: { callId: string; from: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
      const currentCall = directCallRef.current
      if (!currentCall || currentCall.id !== callId || currentCall.peerSocketId !== from) return
      const peerId = `dm-call:${callId}`
      const peer = ensureDirectCallPeerConnection(callId, from, currentCall.direction === 'outgoing', connection)
      try {
        if (description) {
          await peer.setRemoteDescription(description)
          const queued = pendingCandidates.current.get(peerId) ?? []
          pendingCandidates.current.delete(peerId)
          for (const queuedCandidate of queued) await peer.addIceCandidate(queuedCandidate)
          if (description.type === 'offer') {
            await peer.setLocalDescription(await peer.createAnswer())
            if (peer.localDescription) connection.emit('dm-call:signal', { callId, to: from, description: peer.localDescription })
          }
        }
        if (candidate) {
          if (peer.remoteDescription) await peer.addIceCandidate(candidate)
          else pendingCandidates.current.set(peerId, [...(pendingCandidates.current.get(peerId) ?? []), candidate])
        }
      } catch (error) {
        setNotice(`Direct call connection error: ${error instanceof Error ? error.message : 'unknown error'}`)
        connection.emit('dm-call:end', { callId })
        clearDirectCall(callId)
      }
    })
    connection.on('connect', () => {
      setBackendOnline(true)
      connection.emit('channel:join', { serverId: activeServerIdRef.current, channel: activeChannelRef.current })
      connection.emit('member:join', { serverId: activeServerIdRef.current, author: profileNameRef.current })
      syncDirectConversations()
      syncFriends()
    })
    connection.on('disconnect', () => {
      setBackendOnline(false)
      const callId = directCallRef.current?.id
      if (callId) clearDirectCall(callId)
      micSwitchRequest.current += 1
      activeVoiceRef.current = null
      activeVoiceServerRef.current = null
      deafenedRef.current = false
      setActiveVoice(null)
      setVoiceStageOpen(false)
      setPinnedVoicePeerId(null)
      peerConnections.current.forEach((peer) => peer.close())
      peerConnections.current.clear()
      pendingCandidates.current.clear()
      localStream.current?.getTracks().forEach((track) => track.stop())
      localStream.current = null
      outgoingAudioStream.current?.getTracks().forEach((track) => track.stop())
      outgoingAudioStream.current = null
      micSourceNode.current?.disconnect()
      micSourceNode.current = null
      micGainNode.current?.disconnect()
      micGainNode.current = null
      localVideoStreamRef.current?.getTracks().forEach((track) => track.stop())
      localVideoStreamRef.current = null
      setLocalVideoStream(null)
      setVideoMode(null)
      setRemoteStreams({})
      setIsMuted(false)
      setIsDeafened(false)
      setVoicePeers([])
      if (voiceJoinNoticeTimer.current !== null) window.clearTimeout(voiceJoinNoticeTimer.current)
      voiceJoinNoticeTimer.current = null
      setVoiceJoinNotice('')
      if (voiceAudioContext.current && voiceAudioContext.current.state !== 'closed') void voiceAudioContext.current.close()
      voiceAudioContext.current = null
    })
    connection.on('chat:message', (incoming: ChatMessage) => {
      const isNewMessage = !notifiedChatMessageIds.current.has(incoming.id)
      if (isNewMessage) {
        if (notifiedChatMessageIds.current.size >= 500) {
          const oldestMessageId = notifiedChatMessageIds.current.values().next().value
          if (oldestMessageId) notifiedChatMessageIds.current.delete(oldestMessageId)
        }
        notifiedChatMessageIds.current.add(incoming.id)
        if (incoming.authorId !== reactionUserId.current) playNotificationSound()
      }
      setChatMessages((current) => {
        if (current.some((item) => item.id === incoming.id)) return current
        return [...current, incoming]
      })
    })
    const onChatReaction = ({ messageId, reactions }: { messageId: string; reactions: Record<string, string[]> }) => {
      setChatMessages((current) => current.map((item) => item.id === messageId ? { ...item, reactions } : item))
    }
    connection.on('chat:reaction', onChatReaction)
    connection.on('voice:members', ({ serverId, channel, members }: VoiceMembers) => {
      setVoiceMembers((current) => ({ ...current, [voiceRoomKey(serverId, channel)]: members }))
    })
    const connectPeer = (peerId: string, serverId: string, channel: string) => {
      try {
        ensurePeerConnection(peerId, connection, serverId, channel)
      } catch (error) {
        setNotice(`Could not configure voice connection: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    const onRoster = ({ serverId, channel, peers }: VoiceRoster) => {
      if (serverId !== activeVoiceServerRef.current || channel !== activeVoiceRef.current) return
      setVoicePeers(peers)
      peers.forEach(({ id }) => connectPeer(id, serverId, channel))
    }
    const onPeerJoined = (joinedPeer: VoicePeer & { serverId: string; channel: string }) => {
      if (joinedPeer.serverId !== activeVoiceServerRef.current || joinedPeer.channel !== activeVoiceRef.current) return
      setVoicePeers((current) => current.some(({ id }) => id === joinedPeer.id) ? current : [...current, joinedPeer])
      playVoiceJoinSound()
      showVoiceJoinNotice(joinedPeer.author)
      showNativeVoiceNotification(joinedPeer.author, joinedPeer.channel)
      connectPeer(joinedPeer.id, joinedPeer.serverId, joinedPeer.channel)
    }
    const onPeerLeft = ({ id, serverId, channel }: { id: string; serverId: string; channel: string }) => {
      if (serverId !== activeVoiceServerRef.current || channel !== activeVoiceRef.current) return
      setVoicePeers((current) => current.filter((member) => member.id !== id))
      setPinnedVoicePeerId((current) => current === id ? null : current)
      peerConnections.current.get(id)?.close()
      peerConnections.current.delete(id)
      pendingCandidates.current.delete(id)
      makingOffer.current.delete(id)
      ignoreOffer.current.delete(id)
      setRemoteStreams((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
    const onMemberMuted = ({ id, muted, serverId, channel }: { id: string; muted: boolean; serverId: string; channel: string }) => {
      if (serverId === activeVoiceServerRef.current && channel === activeVoiceRef.current) {
        setVoicePeers((current) => current.map((member) => member.id === id ? { ...member, muted } : member))
      }
    }
    const onSpeaking = ({ id, speaking, serverId, channel }: { id: string; speaking: boolean; serverId: string; channel: string }) => {
      if (serverId === activeVoiceServerRef.current && channel === activeVoiceRef.current) {
        setVoicePeers((current) => current.map((member) => member.id === id ? { ...member, speaking } : member))
      }
    }
    const onVideoMode = ({ id, videoMode, serverId, channel }: { id: string; videoMode: 'camera' | 'screen' | null; serverId: string; channel: string }) => {
      if (serverId === activeVoiceServerRef.current && channel === activeVoiceRef.current
        && (videoMode === null || videoMode === 'camera' || videoMode === 'screen')) {
        setVoicePeers((current) => current.map((member) => member.id === id ? { ...member, videoMode } : member))
      }
    }
    const onSignal = async ({ from, serverId, channel, description, candidate }: VoiceSignal) => {
      if (serverId !== activeVoiceServerRef.current || channel !== activeVoiceRef.current) return
      try {
        const peer = ensurePeerConnection(from, connection, serverId, channel)
        if (description) {
          const polite = Boolean(connection.id && connection.id.localeCompare(from) > 0)
          const offerCollision = description.type === 'offer' && (makingOffer.current.has(from) || peer.signalingState !== 'stable')
          if (offerCollision && !polite) {
            ignoreOffer.current.add(from)
            return
          }
          ignoreOffer.current.delete(from)
          if (offerCollision && polite) await peer.setLocalDescription({ type: 'rollback' })
          await peer.setRemoteDescription(description)
          const queued = pendingCandidates.current.get(from) ?? []
          pendingCandidates.current.delete(from)
          for (const queuedCandidate of queued) await peer.addIceCandidate(queuedCandidate)
          if (description.type === 'offer') {
            const answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            connection.emit('voice:signal', { to: from, serverId, channel, description: peer.localDescription })
          }
        }
        if (candidate) {
          if (ignoreOffer.current.has(from)) return
          if (peer.remoteDescription) await peer.addIceCandidate(candidate)
          else pendingCandidates.current.set(from, [...(pendingCandidates.current.get(from) ?? []), candidate])
        }
      } catch (error) {
        setNotice(`Voice connection error: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    connection.on('voice:roster', onRoster)
    connection.on('voice:peer-joined', onPeerJoined)
    connection.on('voice:peer-left', onPeerLeft)
    connection.on('voice:member-muted', onMemberMuted)
    connection.on('voice:speaking', onSpeaking)
    connection.on('voice:video-mode', onVideoMode)
    connection.on('voice:signal', onSignal)
    return () => {
      connection.disconnect()
      micSwitchRequest.current += 1
      activeVoiceRef.current = null
      activeVoiceServerRef.current = null
      if (voiceJoinNoticeTimer.current !== null) window.clearTimeout(voiceJoinNoticeTimer.current)
      voiceJoinNoticeTimer.current = null
      setVoiceJoinNotice('')
      connection.off('voice:roster', onRoster)
      connection.off('voice:peer-joined', onPeerJoined)
      connection.off('voice:peer-left', onPeerLeft)
      connection.off('voice:member-muted', onMemberMuted)
      connection.off('voice:speaking', onSpeaking)
      connection.off('voice:video-mode', onVideoMode)
      connection.off('voice:signal', onSignal)
      connection.off('chat:reaction', onChatReaction)
      connection.off('servers:list', syncServerList)
      connection.off('servers:updated', syncServerList)
      connection.off('channels:list', syncChannelLists)
      connection.off('channels:updated', syncChannelLists)
      connection.off('members:list', syncOnlineMembers)
      connection.off('dm:message')
      connection.off('dm-call:incoming')
      connection.off('dm-call:accepted')
      connection.off('dm-call:answered-elsewhere')
      connection.off('dm-call:ended')
      connection.off('dm-call:signal')
      peerConnections.current.forEach((peer) => peer.close())
      peerConnections.current.clear()
      localStream.current?.getTracks().forEach((track) => track.stop())
      localStream.current = null
      directCallStreamRef.current?.getTracks().forEach((track) => track.stop())
      directCallStreamRef.current = null
      directCallStreamIdRef.current = null
      directCallRef.current = null
      outgoingAudioStream.current?.getTracks().forEach((track) => track.stop())
      outgoingAudioStream.current = null
      micSourceNode.current?.disconnect()
      micSourceNode.current = null
      micGainNode.current?.disconnect()
      micGainNode.current = null
      localVideoStreamRef.current?.getTracks().forEach((track) => track.stop())
      localVideoStreamRef.current = null
      setLocalVideoStream(null)
      setVideoMode(null)
      if (voiceAudioContext.current && voiceAudioContext.current.state !== 'closed') void voiceAudioContext.current.close()
      voiceAudioContext.current = null
    }
  }, [])

  useEffect(() => {
    const stream = localStream.current
    const channel = activeVoice
    if (!socket || !channel || !stream || isMuted || isDeafened || micVolume === 0 || !stream.getAudioTracks().some((track) => track.enabled)) {
      if (localSpeaking.current && channel) socket?.emit('voice:speaking', { serverId: activeVoiceServerRef.current, speaking: false })
      localSpeaking.current = false
      setIsSpeaking(false)
      return
    }

    let context: AudioContext | null = null
    let frame = 0
    let speaking = false
    let lastLoudAt = 0
    try {
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      void context.resume()

      const sampleMicrophone = () => {
        analyser.getByteTimeDomainData(samples)
        let sumSquares = 0
        for (const sample of samples) {
          const normalized = (sample - 128) / 128
          sumSquares += normalized * normalized
        }
        const level = Math.sqrt(sumSquares / samples.length)
        const now = performance.now()
        if (level >= 0.035) lastLoudAt = now
        const nextSpeaking = lastLoudAt > 0 && now - lastLoudAt < 280
        if (speaking !== nextSpeaking) {
          speaking = nextSpeaking
          localSpeaking.current = nextSpeaking
          setIsSpeaking(nextSpeaking)
          socket.emit('voice:speaking', { serverId: activeVoiceServerRef.current, speaking: nextSpeaking })
        }
        frame = requestAnimationFrame(sampleMicrophone)
      }
      frame = requestAnimationFrame(sampleMicrophone)
    } catch (error) {
      setNotice(`Could not monitor microphone level: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    return () => {
      cancelAnimationFrame(frame)
      if (speaking) socket.emit('voice:speaking', { serverId: activeVoiceServerRef.current, speaking: false })
      localSpeaking.current = false
      setIsSpeaking(false)
      if (context && context.state !== 'closed') void context.close()
    }
  }, [socket, activeVoice, activeServerId, isMuted, isDeafened, micVolume])

  useEffect(() => {
    void enumerateAudioDevices()
    const mediaDevices = navigator.mediaDevices
    const onDeviceChange = () => { void enumerateAudioDevices() }
    mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
  }, [])

  useEffect(() => {
    try {
      const savedPicture = localStorage.getItem(`reform-profile-picture-${user.id}`)
      setProfilePicture(savedPicture ? normalizeProfilePicture(savedPicture) : null)
    } catch (error) {
      setNotice(`Could not load profile picture: ${error instanceof Error ? error.message : 'storage unavailable'}`)
    } finally {
      setProfilePictureLoaded(true)
    }
  }, [user.id])

  useEffect(() => {
    if (!profilePictureLoaded) return
    try {
      if (profilePicture) localStorage.setItem(`reform-profile-picture-${user.id}`, profilePicture)
      else localStorage.removeItem(`reform-profile-picture-${user.id}`)
    } catch (error) {
      setNotice(`Could not save profile picture: ${error instanceof Error ? error.message : 'storage unavailable'}`)
    }
  }, [profilePicture, profilePictureLoaded, user.id])

  useEffect(() => {
    if (!profilePictureLoaded || !profilePicture) return
    void syncProfilePicture(profilePicture).catch((error: Error) => {
      setNotice(`Could not sync profile picture to chat: ${error.message}`)
    })
  }, [profilePicture, profilePictureLoaded, user.id])

  useEffect(() => {
    try {
      localStorage.setItem(`reform-progression-v2-${user.id}`, JSON.stringify(progress))
    } catch (error) {
      setNotice(`Could not save quest progress: ${error instanceof Error ? error.message : 'storage unavailable'}`)
    }
  }, [progress, user.id])

  useEffect(() => {
    setProgress((current) => current.dailySignIn ? current : { ...current, dailySignIn: true })
  }, [])

  useEffect(() => {
    const refreshPeriods = () => {
      const { dayKey, weekKey } = getProgressPeriod()
      setProgress((current) => {
        if (current.dayKey === dayKey && current.weekKey === weekKey) return current
        const nextWeek = current.weekKey !== weekKey
        return {
          ...current,
          dayKey,
          weekKey,
          dailySignIn: current.dayKey === dayKey ? current.dailySignIn : false,
          dailyMessages: current.dayKey === dayKey ? current.dailyMessages : 0,
          dailyReactions: current.dayKey === dayKey ? current.dailyReactions : 0,
          dailyVoiceJoins: current.dayKey === dayKey ? current.dailyVoiceJoins : 0,
          weeklyMessages: nextWeek ? 0 : current.weeklyMessages,
          weeklyReactions: nextWeek ? 0 : current.weeklyReactions,
          weeklyVoiceDays: nextWeek ? [] : current.weeklyVoiceDays,
          claimed: current.claimed.filter((claim) => claim.startsWith(`${dayKey}:`) || claim.startsWith(`${weekKey}:`)),
        }
      })
    }
    const interval = window.setInterval(refreshPeriods, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = null
    if (!notice) return
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice('')
    }, 3500)
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
  }, [notice, noticeSequence])

  useEffect(() => {
    if (!viewedProfile) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewedProfile(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [viewedProfile])

  useEffect(() => {
    if (!channelCreationType) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isCreatingChannel) setChannelCreationType(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [channelCreationType, isCreatingChannel])

  useEffect(() => {
    if (!reactionPickerFor) return
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (reactionPickerRef.current?.contains(target) || reactionPickerTriggerRef.current?.contains(target))) return
      setReactionPickerFor(null)
      setReactionPickerPosition(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setReactionPickerFor(null)
        setReactionPickerPosition(null)
      }
    }
    document.addEventListener('pointerdown', closeIfOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [reactionPickerFor])

  useEffect(() => {
    if (!activeVoice) {
      setVoiceSignal('unknown')
      return
    }

    let cancelled = false
    const measureSignal = async () => {
      const peers = [...peerConnections.current.values()]
      const reports = await Promise.all(peers.map((peer) => peer.getStats()))
      if (cancelled) return
      const rtts: number[] = []
      for (const report of reports) {
        report.forEach((stat) => {
          if (stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded')) && typeof stat.currentRoundTripTime === 'number') {
            rtts.push(stat.currentRoundTripTime)
          }
        })
      }
      if (rtts.length) {
        const worstRtt = Math.max(...rtts)
        setVoiceSignal(worstRtt < 0.15 ? 'strong' : worstRtt < 0.35 ? 'fair' : 'weak')
      } else if (peers.some((peer) => peer.connectionState === 'connecting' || peer.iceConnectionState === 'checking')) {
        setVoiceSignal('unknown')
      } else if (peers.length) {
        setVoiceSignal('weak')
      } else {
        setVoiceSignal('unknown')
      }
    }
    const interval = window.setInterval(() => {
      void measureSignal().catch((error: Error) => {
        if (!cancelled) setNotice(`Could not measure voice connection: ${error.message}`)
      })
    }, 2000)
    void measureSignal().catch((error: Error) => setNotice(`Could not measure voice connection: ${error.message}`))
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeVoice, voicePeers])

  useEffect(() => {
    if (micGainNode.current) micGainNode.current.gain.value = micVolume / 100
  }, [micVolume])

  useEffect(() => {
    const audioElements = document.querySelectorAll<HTMLAudioElement>('.remote-voice-audio')
    audioElements.forEach((element) => {
      element.volume = outputVolume / 100
      if ('setSinkId' in HTMLMediaElement.prototype && element.sinkId !== selectedOutputId) {
        void element.setSinkId(selectedOutputId).catch((error: Error) => {
          setNotice(`Could not change output device: ${error.message}`)
        })
      }
    })
  }, [remoteStreams, outputVolume, selectedOutputId, isDeafened])

  useEffect(() => {
    if (!socket) return
    if (!servers.some((server) => server.id === activeServerId)) return
    let cancelled = false
    socket.emit('member:join', { serverId: activeServerId, author: profileName })
    socket.emit('channel:join', { serverId: activeServerId, channel: activeChannel })
    fetch(`/api/servers/${encodeURIComponent(activeServerId)}/channels/${encodeURIComponent(activeChannel)}/messages`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load channel messages.')
        return response.json() as Promise<ChatMessage[]>
      })
      .then((loadedMessages) => {
        if (!cancelled) {
          setChatMessages((current) => {
            const knownIds = new Set(current.map((item) => item.id))
            return [...current, ...loadedMessages.filter((item) => !knownIds.has(item.id))]
          })
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setNotice(error.message)
      })
    return () => { cancelled = true }
  }, [socket, activeServerId, activeChannel, profileName, servers.some((server) => server.id === activeServerId)])

  useEffect(() => {
    if (!socket || !activeDmContact) return
    let cancelled = false
    setDirectMessages([])
    setDirectMessageStreak({ streak: 0, activeToday: false, lastSharedDay: null })
    socket.emit('dm:join', { contactId: activeDmContact.id }, (result: { error?: string }) => {
      if (result.error && !cancelled) setNotice(result.error)
    })
    fetch(`/api/dms/${encodeURIComponent(reactionUserId.current)}/${encodeURIComponent(activeDmContact.id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load this direct conversation.')
        return response.json() as Promise<{ messages: DirectMessage[]; streak: DirectMessageStreak }>
      })
      .then(({ messages: loadedMessages, streak }) => {
        if (!cancelled) {
          setDirectMessages((current) => {
            const knownIds = new Set(current.map(({ id }) => id))
            return [...current, ...loadedMessages.filter(({ id }) => !knownIds.has(id))]
          })
          setDirectMessageStreak(streak)
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setNotice(error.message)
      })
    return () => {
      cancelled = true
      socket.emit('dm:leave')
    }
  }, [socket, activeDmContact?.id])

  const joinVoice = async (channel: string) => {
    setMobileSidebarOpen(false)
    if (!socket?.connected) {
      setNotice('Backend is offline. Start the app with npm run dev to connect voice presence.')
      return
    }
    if (activeVoice === channel && activeVoiceServerRef.current === activeServerId) {
      setVoiceStageOpen(true)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStageOpen(false)
      setNotice('Microphone access is not available in this browser.')
      return
    }
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch((error: unknown) => {
        console.warn('Could not request native notification permission:', error)
      })
    }
    if (activeVoice) disconnectVoice()
    try {
      const requestedServerId = activeServerId
      if (!voiceAudioContext.current || voiceAudioContext.current.state === 'closed') {
        voiceAudioContext.current = new AudioContext()
      }
      await voiceAudioContext.current.resume()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (activeServerIdRef.current !== requestedServerId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localStream.current = stream
      createOutgoingAudioStream(stream)
      stream.getAudioTracks().forEach((track) => { track.enabled = !isMuted && !isDeafened })
      await enumerateAudioDevices()
      setIsMuted(false)
      setIsDeafened(false)
      deafenedRef.current = false
      setVoicePeers([])
      activeVoiceRef.current = channel
      activeVoiceServerRef.current = requestedServerId
      setActiveVoice(channel)
      setVoiceStageOpen(true)
      socket.emit('voice:join', { serverId: requestedServerId, channel, author: profileName })
      updateProgress((current) => ({
        ...current,
        dailyVoiceJoins: current.dailyVoiceJoins + 1,
        weeklyVoiceDays: current.weeklyVoiceDays.includes(getProgressPeriod().dayKey)
          ? current.weeklyVoiceDays
          : [...current.weeklyVoiceDays, getProgressPeriod().dayKey],
      }))
      playVoiceJoinSound()
      setNotice('')
    } catch (error) {
      setVoiceStageOpen(false)
      const reason = error instanceof Error ? error.message : 'microphone permission was denied'
      setNotice(`Could not access microphone: ${reason}`)
    }
  }

  const disconnectVoice = () => {
    micSwitchRequest.current += 1
    activeVoiceRef.current = null
    activeVoiceServerRef.current = null
    deafenedRef.current = false
    socket?.emit('voice:leave')
    if (voiceJoinNoticeTimer.current !== null) window.clearTimeout(voiceJoinNoticeTimer.current)
    voiceJoinNoticeTimer.current = null
    setVoiceJoinNotice('')
    peerConnections.current.forEach((peer) => peer.close())
    peerConnections.current.clear()
    pendingCandidates.current.clear()
    localStream.current?.getTracks().forEach((track) => track.stop())
    localStream.current = null
    outgoingAudioStream.current?.getTracks().forEach((track) => track.stop())
    outgoingAudioStream.current = null
    micSourceNode.current?.disconnect()
    micSourceNode.current = null
    micGainNode.current?.disconnect()
    micGainNode.current = null
    localVideoStreamRef.current?.getTracks().forEach((track) => track.stop())
    localVideoStreamRef.current = null
    setLocalVideoStream(null)
    setVideoMode(null)
    if (voiceAudioContext.current && voiceAudioContext.current.state !== 'closed') void voiceAudioContext.current.close()
    voiceAudioContext.current = null
    setRemoteStreams({})
    setIsMuted(false)
    setIsDeafened(false)
    deafenedRef.current = false
    setVoicePeers([])
    setActiveVoice(null)
    setVoiceStageOpen(false)
    setPinnedVoicePeerId(null)
  }
  disconnectVoiceRef.current = disconnectVoice

  const startDirectCall = async () => {
    const contact = activeDmContact
    if (!contact || !socket?.connected) {
      setNotice('Connect to REFORM and open a direct conversation before calling.')
      return
    }
    if (!contact.online) {
      setNotice(`${contact.name} is offline and cannot receive a call.`)
      return
    }
    if (activeVoiceRef.current) {
      setNotice('Leave your voice lounge before starting a direct call.')
      return
    }
    if (directCallRef.current) {
      setNotice('Finish your current direct call before starting another.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice('Microphone access is not available in this browser.')
      return
    }

    const requestId = ++directCallRequestRef.current
    const startingCall: DirectCall = {
      id: '',
      contactId: contact.id,
      contactName: contact.name,
      direction: 'outgoing',
      status: 'starting',
    }
    directCallRef.current = startingCall
    setDirectCall(startingCall)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (requestId !== directCallRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      directCallStreamRef.current = stream
      directCallStreamIdRef.current = `pending:${requestId}`
      socket.timeout(10_000).emit('dm-call:start', { toId: contact.id }, (timeoutError: Error | null, response?: { callId?: string; error?: string }) => {
        if (timeoutError || !response) {
          disposeDirectCallMedia(`pending:${requestId}`)
          clearDirectCall('')
          setNotice('The call could not be started because the server did not respond.')
          return
        }
        if (requestId !== directCallRequestRef.current) {
          if (response.callId) socket.emit('dm-call:end', { callId: response.callId })
          if (response.callId) disposeDirectCallMedia(response.callId)
          return
        }
        if (response.error || !response.callId) {
          disposeDirectCallMedia(`pending:${requestId}`)
          clearDirectCall('')
          setNotice(response.error ?? 'The call could not be started.')
          return
        }
        directCallStreamIdRef.current = response.callId
        const ringingCall = { ...startingCall, id: response.callId, status: 'ringing' as const }
        directCallRef.current = ringingCall
        setDirectCall(ringingCall)
      })
    } catch (error) {
      if (requestId === directCallRequestRef.current) {
        clearDirectCall('')
        setNotice(`Could not access microphone: ${error instanceof Error ? error.message : 'permission was denied'}`)
      }
    }
  }

  const acceptDirectCall = async () => {
    const call = directCallRef.current
    if (!call || call.direction !== 'incoming' || call.status !== 'ringing' || !socket?.connected) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice('Microphone access is not available in this browser.')
      return
    }
    if (activeVoiceRef.current) disconnectVoice()
    directCallRef.current = { ...call, status: 'connecting' }
    setDirectCall(directCallRef.current)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (directCallRef.current?.id !== call.id) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      directCallStreamRef.current = stream
      directCallStreamIdRef.current = call.id
      socket.timeout(10_000).emit('dm-call:accept', { callId: call.id }, (timeoutError: Error | null, response?: { error?: string }) => {
        if (timeoutError || !response || response.error) {
          clearDirectCall(call.id)
          setNotice(timeoutError || !response ? 'The call could not be answered because the server did not respond.' : response.error!)
        }
      })
    } catch (error) {
      if (directCallRef.current?.id === call.id) {
        directCallRef.current = { ...call, status: 'ringing' }
        setDirectCall(directCallRef.current)
        setNotice(`Could not access microphone: ${error instanceof Error ? error.message : 'permission was denied'}`)
      }
    }
  }

  const declineDirectCall = () => {
    const call = directCallRef.current
    if (!call) return
    if (call.id) socket?.emit('dm-call:decline', { callId: call.id })
    clearDirectCall(call.id)
    setNotice('You declined the call.')
  }

  const endDirectCall = () => {
    const call = directCallRef.current
    if (!call) return
    directCallRequestRef.current += 1
    if (call.id) {
      socket?.emit('dm-call:end', { callId: call.id })
      clearDirectCall(call.id)
    } else {
      directCallStreamRef.current?.getTracks().forEach((track) => track.stop())
      directCallStreamRef.current = null
      directCallStreamIdRef.current = null
      directCallRef.current = null
      setDirectCall(null)
    }
  }

  const toggleDirectCallMute = () => {
    const nextMuted = !isDirectCallMuted
    directCallStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted })
    setIsDirectCallMuted(nextMuted)
  }

  const selectServer = (server: ServerDefinition) => {
    setMobileSidebarOpen(false)
    setVoiceStageOpen(false)
    setDirectMessagesOpen(false)
    if (server.id === activeServerId) {
      setActiveDmContact(null)
      setCommunityTab(null)
      setServerMenuOpen(false)
      return
    }
    if (activeVoiceRef.current) disconnectVoice()
    activeServerIdRef.current = server.id
    setActiveServerId(server.id)
    setTextChannelList(server.textChannels.filter(({ label }) => label !== 'welcome'))
    setVoiceChannelList(server.voiceChannels)
    setActiveChannel('welcome')
    setActiveDmContact(null)
    setCommunityTab(null)
    setServerMenuOpen(false)
    setEmojiPickerOpen(false)
    setReactionPickerFor(null)
    setReactionPickerPosition(null)
    try {
      localStorage.setItem('reform-active-server', server.id)
    } catch (error) {
      setNotice(`Could not save the selected server: ${error instanceof Error ? error.message : 'storage unavailable'}`)
    }
  }

  const changeMicrophone = async (deviceId: string) => {
    const channel = activeVoice
    if (!channel || !localStream.current || !voiceAudioContext.current) {
      setSelectedMicId(deviceId)
      return
    }
    const requestId = ++micSwitchRequest.current
    let replacementStream: MediaStream | null = null
    let replacementOutgoing: MediaStream | null = null
    const previousOutgoing = outgoingAudioStream.current
    const previousSource = micSourceNode.current
    const previousGain = micGainNode.current
    try {
      replacementStream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (requestId !== micSwitchRequest.current || activeVoiceRef.current !== channel || !voiceAudioContext.current || voiceAudioContext.current.state === 'closed') {
        replacementStream.getTracks().forEach((track) => track.stop())
        return
      }
      replacementStream.getAudioTracks().forEach((track) => { track.enabled = !isMuted && !isDeafened })
      replacementOutgoing = createOutgoingAudioStream(replacementStream)
      await Promise.all([...peerConnections.current.values()].map(async (peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'audio')
        const track = replacementOutgoing?.getAudioTracks()[0]
        if (sender && track) await sender.replaceTrack(track)
      }))
      const previous = localStream.current
      localStream.current = replacementStream
      previous.getTracks().forEach((track) => track.stop())
      previousSource?.disconnect()
      previousGain?.disconnect()
      previousOutgoing?.getTracks().forEach((track) => track.stop())
      setSelectedMicId(deviceId)
      await enumerateAudioDevices()
    } catch (error) {
      if (replacementStream && replacementStream !== localStream.current) replacementStream.getTracks().forEach((track) => track.stop())
      if (replacementOutgoing && replacementOutgoing !== outgoingAudioStream.current) replacementOutgoing.getTracks().forEach((track) => track.stop())
      micSwitchRequest.current += 1
      setNotice(`Could not switch microphone: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const startCamera = async () => {
    if (!activeVoice) {
      setNotice('Join a voice channel before turning on your camera.')
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (activeVoiceRef.current !== activeVoice) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const track = stream.getVideoTracks()[0]
      track?.addEventListener('ended', () => {
        if (localVideoStreamRef.current === stream) {
          void replaceVideoTrack(null).catch((error: Error) => setNotice(`Could not stop camera track: ${error.message}`))
          setVideoMode(null)
          socket?.emit('voice:video-mode', { videoMode: null })
        }
      }, { once: true })
      await replaceVideoTrack(stream)
      setVideoMode('camera')
      socket?.emit('voice:video-mode', { videoMode: 'camera' })
      setNotice('')
    } catch (error) {
      if (stream && localVideoStreamRef.current !== stream) stream.getTracks().forEach((track) => track.stop())
      setNotice(`Could not start camera: ${error instanceof Error ? error.message : 'permission was denied'}`)
    }
  }

  const startScreenShare = async () => {
    if (!activeVoice) {
      setNotice('Join a voice channel before sharing your screen.')
      return
    }
    if (!navigator.mediaDevices.getDisplayMedia) {
      setNotice('Screen sharing is not supported by this browser.')
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false })
      if (activeVoiceRef.current !== activeVoice) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const track = stream.getVideoTracks()[0]
      if (track) track.addEventListener('ended', () => {
        if (localVideoStreamRef.current === stream) {
          void replaceVideoTrack(null).catch((error: Error) => setNotice(`Could not stop screen share: ${error.message}`))
          setVideoMode(null)
          socket?.emit('voice:video-mode', { videoMode: null })
        }
      }, { once: true })
      await replaceVideoTrack(stream)
      setVideoMode('screen')
      socket?.emit('voice:video-mode', { videoMode: 'screen' })
      setNotice('')
    } catch (error) {
      if (error instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(error.name)) return
      if (stream && localVideoStreamRef.current !== stream) stream.getTracks().forEach((track) => track.stop())
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        setNotice('Screen sharing is not supported in this browser or app context. Use an up-to-date browser on localhost or HTTPS.')
        return
      }
      setNotice(`Could not share screen: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const stopVideo = async () => {
    await replaceVideoTrack(null)
    setVideoMode(null)
    socket?.emit('voice:video-mode', { videoMode: null })
  }

  const setOutputDevice = async (deviceId: string) => {
    setSelectedOutputId(deviceId)
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      if (deviceId) setNotice('Choosing an output device is not supported by this browser.')
      return
    }

    try {
      const audioElements = document.querySelectorAll<HTMLAudioElement>('.remote-voice-audio')
      await Promise.all([...audioElements].map((element) => element.setSinkId(deviceId)))
    } catch (error) {
      setNotice(`Could not change output device: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const syncProfilePicture = (data: string) => {
    if (profilePictureSync.current?.data === data) return profilePictureSync.current.promise
    let promise: Promise<void>
    promise = (async () => {
      const response = await fetch('/api/profile-pictures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: reactionUserId.current, data }),
      })
      const result = await response.json() as { url?: string; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The profile picture could not be synced.')
      if (typeof result.url !== 'string') throw new Error('The server returned an invalid profile picture URL.')
    })().catch((error: Error) => {
      if (profilePictureSync.current?.promise === promise) profilePictureSync.current = null
      throw error
    })
    profilePictureSync.current = { data, promise }
    return promise
  }

  const uploadProfilePicture = (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      setNotice('Choose a PNG, JPEG, GIF, or WebP image for your profile picture.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setNotice('Profile pictures must be 5 MB or smaller.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setProfilePicture(reader.result)
      else setNotice('Could not read the selected profile picture.')
    }
    reader.onerror = () => setNotice('Could not read the selected profile picture.')
    reader.readAsDataURL(file)
  }

  const toggleMicrophone = () => {
    const nextMuted = !isMuted
    const microphoneEnabled = !nextMuted && !isDeafened
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = microphoneEnabled })
    setIsMuted(nextMuted)
    if (activeVoice) socket?.emit('voice:mute', { muted: !microphoneEnabled })
  }

  const toggleDeafen = () => {
    const nextDeafened = !isDeafened
    deafenedRef.current = nextDeafened
    const microphoneEnabled = !nextDeafened && !isMuted
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = microphoneEnabled })
    setIsDeafened(nextDeafened)
    if (activeVoice) socket?.emit('voice:mute', { muted: !microphoneEnabled })
  }

  const addAttachments = (files: FileList | null) => {
    if (!files?.length) return
    const accepted: File[] = []
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        setNotice(`${file.name} is empty and cannot be attached.`)
      } else if (file.size > maxAttachmentSize) {
        setNotice(`${file.name} is larger than the 5 MB file limit.`)
      } else {
        accepted.push(file)
      }
    }
    const availableSlots = attachmentLimit - pendingAttachments.length
    if (accepted.length > availableSlots) setNotice(`You can attach up to ${attachmentLimit} files per message.`)
    if (availableSlots > 0) setPendingAttachments((current) => [...current, ...accepted].slice(0, attachmentLimit))
  }

  const uploadAttachment = async (file: File): Promise<ChatAttachment> => {
    const encodedData = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error(`Could not read ${file.name}.`))
          return
        }
        const separator = reader.result.indexOf(',')
        if (separator < 0) {
          reject(new Error(`Could not encode ${file.name}.`))
          return
        }
        resolve(reader.result.slice(separator + 1))
      }
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
      reader.readAsDataURL(file)
    })
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, mimeType: file.type, data: encodedData }),
    })
    const result = await response.json() as ChatAttachment & { error?: string }
    if (!response.ok) throw new Error(result.error ?? `Could not upload ${file.name}.`)
    return result
  }

  const sendMessage = async () => {
    if (isSendingMessage) return
    const content = message.trim()
    if (!content && pendingAttachments.length === 0) return
    if (content.length > 1000) {
      setNotice('Messages can contain up to 1,000 characters.')
      return
    }
    if (!socket?.connected) {
      setNotice('Backend is offline. Your message and attachments were not sent.')
      return
    }
    setIsSendingMessage(true)
    try {
      if (profilePicture) await syncProfilePicture(profilePicture)
      const attachments = await Promise.all(pendingAttachments.map(uploadAttachment))
      const result = await new Promise<{ message?: ChatMessage; error?: string }>((resolve, reject) => {
        socket.timeout(10_000).emit('chat:send', { serverId: activeServerId, channel: activeChannel, author: profileName, content, attachments }, (timeoutError: Error | null, response?: { message?: ChatMessage; error?: string }) => {
          if (timeoutError) reject(new Error('The chat server did not confirm the message. Please try again.'))
          else if (!response) reject(new Error('The chat server returned an empty response.'))
          else resolve(response)
        })
      })
      if (result.error) throw new Error(result.error)
      if (!result.message) throw new Error('The chat server did not save the message.')
      recordChatProgress()
      setMessage('')
      setPendingAttachments([])
    } catch (error) {
      setNotice(`Could not send message: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSendingMessage(false)
    }
  }

  const sendDirectMessage = async () => {
    const content = directMessageDraft.trim()
    if (!content || isSendingDirectMessage || !activeDmContact) return
    if (content.length > 1000) {
      setNotice('Direct messages can contain up to 1,000 characters.')
      return
    }
    if (!socket?.connected) {
      setNotice('Backend is offline. Your direct message was not sent.')
      return
    }
    setIsSendingDirectMessage(true)
    try {
      const result = await new Promise<{ error?: string }>((resolve, reject) => {
        socket.timeout(10_000).emit('dm:send', { toId: activeDmContact.id, content }, (timeoutError: Error | null, response?: { error?: string }) => {
          if (timeoutError) reject(new Error('The chat server did not confirm your direct message.'))
          else if (!response) reject(new Error('The chat server returned an empty response.'))
          else resolve(response)
        })
      })
      if (result.error) throw new Error(result.error)
      setDirectMessageDraft('')
    } catch (error) {
      setNotice(`Could not send direct message: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSendingDirectMessage(false)
    }
  }

  const toggleMessageReaction = (messageId: string, emoji: string) => {
    if (!socket?.connected) {
      setNotice('Chat is offline. Your reaction was not saved.')
      return
    }
    socket.emit('chat:reaction', { messageId, emoji }, (result: { error?: string; reactions?: Record<string, string[]> }) => {
      if (result.error) setNotice(result.error)
      else if (result.reactions) recordReactionProgress(messageId, emoji, result.reactions)
    })
    setReactionPickerFor(null)
    setReactionPickerPosition(null)
  }

  const toggleReactionPicker = (messageId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    if (reactionPickerFor === messageId) {
      setReactionPickerFor(null)
      setReactionPickerPosition(null)
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const pickerWidth = 206
    setReactionPickerPosition({
      top: Math.min(bounds.bottom + 6, window.innerHeight - 210),
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - pickerWidth - 12)),
    })
    reactionPickerTriggerRef.current = event.currentTarget
    setReactionPickerFor(messageId)
  }

  const claimQuest = (period: 'daily' | 'weekly', id: string, reward: number, complete: boolean) => {
    if (!complete) return
    const claimKey = `${period === 'daily' ? progress.dayKey : progress.weekKey}:${id}`
    if (progress.claimed.includes(claimKey)) return
    updateProgress((current) => ({ ...current, xp: current.xp + reward, claimed: [...current.claimed, claimKey] }))
  }

  const openProfile = (name: string, accountId?: string) => {
    const sequence = ++profileLookupSequence.current
    setViewedProfile(name)
    setViewedAccount(null)
    setIsLoadingViewedAccount(false)
    if (accountId === user.id) return
    const contact = directContacts.find(({ id, name: contactName }) => accountId ? id === accountId : contactName.toLowerCase() === name.toLowerCase())
    if (contact) {
      setViewedAccount(contact)
      return
    }
    setIsLoadingViewedAccount(true)
    const lookupUrl = accountId
      ? `/api/members/${encodeURIComponent(accountId)}`
      : `/api/members?name=${encodeURIComponent(name)}`
    fetch(lookupUrl)
      .then(async (response) => {
        const result = await response.json() as { member?: Friend; error?: string }
        if (!response.ok) throw new Error(result.error ?? 'Could not load this member profile.')
        if (result.member && (typeof result.member.id !== 'string'
          || (accountId && result.member.id !== accountId)
          || result.member.name.toLowerCase() !== name.toLowerCase()
          || typeof result.member.online !== 'boolean')) {
          throw new Error('The server returned an invalid member profile.')
        }
        if (profileLookupSequence.current === sequence) {
          setViewedAccount(result.member ?? null)
          setIsLoadingViewedAccount(false)
        }
      })
      .catch((error: Error) => {
        if (profileLookupSequence.current === sequence) {
          setIsLoadingViewedAccount(false)
          setNotice(`Could not load member profile: ${error.message}`)
        }
      })
  }
  const changeFriendship = async (contact: DirectContact, shouldAdd: boolean) => {
    if (friendActionPending) return
    setFriendActionPending(contact.id)
    try {
      const response = await fetch(`/api/friends/${encodeURIComponent(contact.id)}`, { method: shouldAdd ? 'POST' : 'DELETE' })
      const result = await response.json() as { friend?: Friend; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Your friends list could not be updated.')
      if (shouldAdd) {
        const addedFriend = result.friend
        if (!addedFriend || addedFriend.id !== contact.id || addedFriend.name !== contact.name) {
          throw new Error('The server returned an invalid friend profile.')
        }
        setFriends((current) => current.some(({ id }) => id === contact.id)
          ? current
          : [...current, { ...addedFriend, online: onlineMembers.some(({ id }) => id === contact.id) }])
        setNotice(`${contact.name} added to your friends.`)
      } else {
        setFriends((current) => current.filter(({ id }) => id !== contact.id))
        setNotice(`${contact.name} removed from your friends.`)
      }
    } catch (error) {
      setNotice(`Could not update friends: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setFriendActionPending(null)
    }
  }
  const openDirectMessage = (contact: DirectContact) => {
    setMobileSidebarOpen(false)
    setVoiceStageOpen(false)
    setDirectMessagesOpen(true)
    setActiveDmContact(contact)
    setCommunityTab(null)
    setActiveChannel('welcome')
    setEmojiPickerOpen(false)
    setReactionPickerFor(null)
    setReactionPickerPosition(null)
    setDirectMessageDraft('')
  }
  const saveProfileName = async () => {
    const nextName = profileNameDraft.trim().replace(/\s+/g, ' ')
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,31}$/u.test(nextName)) {
      setNotice('Use a name of 1–32 letters, numbers, spaces, periods, hyphens, or underscores.')
      return
    }
    setIsSavingProfileName(true)
    try {
      const response = await fetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nextName }),
      })
      const result = await response.json() as { account?: AuthAccount; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Your username could not be saved.')
      if (!result.account || typeof result.account.id !== 'string' || result.account.id !== user.id
        || typeof result.account.email !== 'string' || typeof result.account.username !== 'string') {
        throw new Error('The server returned an invalid account.')
      }
      setProfileName(result.account.username)
      setProfileNameDraft(result.account.username)
      onProfileUpdate(result.account)
      socket?.emit('member:profile', { name: result.account.username })
      setNotice('Your username has been updated.')
    } catch (error) {
      setNotice(`Could not save username: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSavingProfileName(false)
    }
  }

  const signOut = async () => {
    if (isSigningOut) return
    setIsSigningOut(true)
    try {
      await onSignOut()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not sign out. Please try again.')
      setIsSigningOut(false)
    }
  }

  const addEmoji = (emoji: string) => {
    setMessage((current) => `${current}${current ? ' ' : ''}${emoji}`)
    setEmojiPickerOpen(false)
  }
  const chatEmojis = ['😀', '😂', '🥹', '😍', '😎', '🤔', '😭', '😡', '👍', '👎', '👏', '🙌', '🔥', '❤️', '💯', '🎮', '🏆', '✨', '👀', '💀']
  const currentLevel = Math.floor(progress.xp / 500)
  const currentLevelXp = progress.xp % 500
  const rankedPlayers = progress.xp > 0 ? [{ name: profileName, level: currentLevel, xp: progress.xp }] : []
  const currentRank = rankedPlayers.findIndex((player) => player.name === profileName) + 1
  const activeServer = servers.find(({ id }) => id === activeServerId) ?? defaultServer
  const isMemberInVoice = (name: string) => Object.entries(voiceMembers).some(([key, members]) =>
    key.startsWith(`${activeServerId}:`) && members.some((member) => member.toLowerCase() === name.toLowerCase()))
  const renderUserNameplate = (
    name: string,
    isOwnMember: boolean,
    joinedVoice = isMemberInVoice(name),
    children: React.ReactNode = <span>{name}</span>,
  ) => (
    <span className={`user-nameplate ${joinedVoice ? 'user-nameplate-voice' : ''}`} title={joinedVoice ? 'Joined a voice lounge' : isOwnMember ? `Level ${currentLevel}` : 'Community member'}>
      <Crown size={9} aria-hidden="true" />
      {children}
      {joinedVoice && <span className="user-nameplate-status">IN VOICE</span>}
    </span>
  )
  const activeVoiceChatLabel = activeChannel.startsWith('voice:') ? activeChannel.slice('voice:'.length) : null
  const activeTextChannel = activeServer.textChannels.find(({ label }) => label === activeChannel)
  const channelTopics: Record<string, string> = {
    welcome: 'Meet the community and welcome new members.',
    ...Object.fromEntries(textChannelList.map(({ label, topic }) => [label, topic])),
  }
  if (activeVoiceChatLabel) channelTopics[activeChannel] = `Chat with everyone in the ${activeVoiceChatLabel} voice lounge.`
  const directContactMap = new Map<string, DirectContact>()
  friends.forEach((friend) => directContactMap.set(friend.id, friend))
  dmSummaries.forEach(({ contact, lastMessage, streak }) => directContactMap.set(contact.id, { ...contact, online: false, lastMessage, streak }))
  onlineMembers.forEach((member) => {
    if (member.id === reactionUserId.current) return
    directContactMap.set(member.id, { ...directContactMap.get(member.id), ...member, online: true })
  })
  const directContacts = [...directContactMap.values()].sort((first, second) =>
    Number(second.online) - Number(first.online)
    || (second.lastMessage?.createdAt ?? '').localeCompare(first.lastMessage?.createdAt ?? '')
    || first.name.localeCompare(second.name))
  const viewedMember = viewedAccount ?? (viewedProfile ? directContacts.find(({ name }) => name === viewedProfile) ?? null : null)
  const viewedMemberIsFriend = viewedMember ? friends.some(({ id }) => id === viewedMember.id) : false
  const friendContacts = directContacts.filter(({ id }) => friends.some((friend) => friend.id === id))
  const conversationContacts = directContacts.filter(({ id }) => !friends.some((friend) => friend.id === id))
  const viewedLeaderboardPlayer = rankedPlayers.find((player) => player.name === viewedProfile)
  const viewedLeaderboardRank = viewedLeaderboardPlayer
    ? rankedPlayers.indexOf(viewedLeaderboardPlayer) + 1
    : null
  const questItems = [
    { id: 'daily-sign-in', period: 'daily' as const, title: 'Daily sign-in', detail: 'Check in today to claim your daily XP reward.', progress: progress.dailySignIn ? 1 : 0, goal: 1, reward: 25, icon: '📅' },
    { id: 'daily-chat', period: 'daily' as const, title: 'Join the conversation', detail: 'Send 3 messages in any text channel.', progress: progress.dailyMessages, goal: 3, reward: 50, icon: '💬' },
    { id: 'daily-reaction', period: 'daily' as const, title: 'Show some love', detail: 'React to 2 community messages.', progress: progress.dailyReactions, goal: 2, reward: 35, icon: '✨' },
    { id: 'daily-voice', period: 'daily' as const, title: 'Squad up', detail: 'Join any voice channel today.', progress: progress.dailyVoiceJoins, goal: 1, reward: 40, icon: '🎧' },
    { id: 'weekly-chat', period: 'weekly' as const, title: 'Regular chatter', detail: 'Send 15 messages this week.', progress: progress.weeklyMessages, goal: 15, reward: 150, icon: '🗨️' },
    { id: 'weekly-reaction', period: 'weekly' as const, title: 'Community cheerleader', detail: 'React to 10 messages this week.', progress: progress.weeklyReactions, goal: 10, reward: 100, icon: '💖' },
    { id: 'weekly-voice', period: 'weekly' as const, title: 'Find your party', detail: 'Join voice on 3 different days this week.', progress: progress.weeklyVoiceDays.length, goal: 3, reward: 125, icon: '🎮' },
  ]
  const openCommunityTab = (tab: 'leaderboard' | 'quests') => {
    setMobileSidebarOpen(false)
    setVoiceStageOpen(false)
    setDirectMessagesOpen(false)
    setActiveDmContact(null)
    setCommunityTab(tab)
    setEmojiPickerOpen(false)
    setReactionPickerFor(null)
    setReactionPickerPosition(null)
  }
  const openChannelCreation = (type: 'text' | 'voice') => {
    setMobileSidebarOpen(false)
    setNewChannelName('')
    setNewChannelTopic('')
    setChannelCreationType(type)
  }
  const channelNameIsValid = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(newChannelName.trim())
  const createChannel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!channelCreationType || isCreatingChannel) return
    if (!channelNameIsValid) {
      setNotice('Use 1–32 letters, numbers, spaces, hyphens, or underscores. Start with a letter or number.')
      return
    }
    if (!backendOnline) {
      setNotice('Connect to the backend before creating channels.')
      return
    }
    setIsCreatingChannel(true)
    try {
      const response = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: activeServerId, type: channelCreationType, name: newChannelName, topic: newChannelTopic }),
      })
      const result = await response.json() as { serverId?: string; type?: 'text' | 'voice'; channel?: TextChannelDefinition | VoiceChannelDefinition; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The channel could not be created.')
      if (!result.channel || result.type !== channelCreationType) throw new Error('The server returned an invalid channel.')

      if (result.type === 'text') {
        if (!('topic' in result.channel)) throw new Error('The server returned an invalid text channel.')
        const textChannel = result.channel
        setTextChannelList((current) => current.some(({ label }) => label === textChannel.label) ? current : [...current, textChannel])
        returnToChannels(textChannel.label)
        setNotice(`#${textChannel.label} was created.`)
      } else {
        if ('topic' in result.channel) throw new Error('The server returned an invalid voice lounge.')
        const voiceChannel = result.channel
        setVoiceChannelList((current) => current.some(({ label }) => label === voiceChannel.label) ? current : [...current, voiceChannel])
        setNotice(`${voiceChannel.label} voice lounge was created.`)
      }
      setChannelCreationType(null)
    } catch (error) {
      setNotice(`Could not create channel: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsCreatingChannel(false)
    }
  }
  const openTextChannelSettings = (channel: TextChannelDefinition) => {
    setChannelNameDraft(channel.label)
    setConfirmChannelDelete(false)
    setChannelSettingsTarget({ serverId: activeServerId, channel })
  }
  const channelNameDraftIsValid = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(channelNameDraft.trim())
  const saveTextChannelSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!channelSettingsTarget || isSavingChannelSettings) return
    if (!channelNameDraftIsValid) {
      setNotice('Use 1–32 letters, numbers, spaces, hyphens, or underscores. Start with a letter or number.')
      return
    }
    setIsSavingChannelSettings(true)
    try {
      const { serverId, channel } = channelSettingsTarget
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channel.label)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: channelNameDraft }),
      })
      const result = await response.json() as { channel?: TextChannelDefinition; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The text channel could not be renamed.')
      if (!result.channel || typeof result.channel.label !== 'string') throw new Error('The server returned an invalid text channel.')
      setNotice(`#${channel.label} was renamed to #${result.channel.label}.`)
      setChannelSettingsTarget(null)
    } catch (error) {
      setNotice(`Could not rename channel: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSavingChannelSettings(false)
    }
  }
  const deleteTextChannel = async () => {
    if (!channelSettingsTarget || isSavingChannelSettings) return
    setIsSavingChannelSettings(true)
    try {
      const { serverId, channel } = channelSettingsTarget
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channel.label)}`, {
        method: 'DELETE',
      })
      const result = await response.json() as { deleted?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The text channel could not be deleted.')
      if (result.deleted !== true) throw new Error('The server did not confirm channel deletion.')
      setNotice(`#${channel.label} was deleted along with its chat history.`)
      setChannelSettingsTarget(null)
    } catch (error) {
      setNotice(`Could not delete channel: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSavingChannelSettings(false)
    }
  }
  const openServerDialog = (mode: 'create' | 'rename') => {
    setServerNameDraft(mode === 'rename' ? activeServer.name : '')
    setServerMenuOpen(false)
    setServerDialogMode(mode)
  }
  const openServerEntry = () => {
    setServerEntryOpen(true)
    setInviteCodeDraft(new URLSearchParams(window.location.search).get('invite') ?? '')
  }
  const joinServer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isJoiningServer) return
    const inviteCode = inviteCodeDraft.trim()
    if (!inviteCode) return
    setIsJoiningServer(true)
    try {
      const response = await fetch(`/api/server-invites/${encodeURIComponent(inviteCode)}`, { method: 'POST' })
      const result = await response.json() as { server?: ServerDefinition; joined?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not join this server.')
      const server = result.server
      if (!server || typeof server.id !== 'string' || !Array.isArray(server.textChannels) || !Array.isArray(server.voiceChannels)) {
        throw new Error('The server returned an invalid server.')
      }
      const nextServers = [...serversRef.current.filter(({ id }) => id !== server.id), server]
      serversRef.current = nextServers
      setServers(nextServers)
      setServerEntryOpen(false)
      setInviteCodeDraft('')
      const cleanUrl = new URL(window.location.href)
      cleanUrl.searchParams.delete('invite')
      window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`)
      selectServer(server)
      setNotice(result.joined ? `You joined ${server.name}.` : `You’re already a member of ${server.name}.`)
    } catch (error) {
      setNotice(`Could not join server: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsJoiningServer(false)
    }
  }
  const openServerInvite = async (server: ServerDefinition) => {
    setServerMenuOpen(false)
    setInviteDialogServer(server)
    setServerInviteCode('')
    setIsLoadingInvite(true)
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(server.id)}/invites`, { method: 'POST' })
      const result = await response.json() as { inviteCode?: string; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not create a server invite.')
      if (typeof result.inviteCode !== 'string' || !result.inviteCode) throw new Error('The server returned an invalid invite.')
      setServerInviteCode(result.inviteCode)
    } catch (error) {
      setNotice(`Could not create invite: ${error instanceof Error ? error.message : 'unknown error'}`)
      setInviteDialogServer(null)
    } finally {
      setIsLoadingInvite(false)
    }
  }
  const copyServerInvite = async () => {
    if (!serverInviteCode) return
    const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(serverInviteCode)}`
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setNotice('Invite link copied to clipboard.')
    } catch (error) {
      setNotice(`Could not copy invite link: ${error instanceof Error ? error.message : 'clipboard unavailable'}`)
    }
  }
  const serverNameIsValid = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(serverNameDraft.trim())
  const saveServer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!serverDialogMode || isSavingServer) return
    if (!serverNameIsValid) {
      setNotice('Use 1–32 letters, numbers, spaces, hyphens, or underscores. Start with a letter or number.')
      return
    }
    setIsSavingServer(true)
    try {
      const isCreating = serverDialogMode === 'create'
      const response = await fetch(isCreating ? '/api/servers' : `/api/servers/${encodeURIComponent(activeServerId)}`, {
        method: isCreating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: serverNameDraft }),
      })
      const result = await response.json() as { server?: ServerDefinition; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The server could not be saved.')
      const savedServer = result.server
      if (!savedServer || typeof savedServer.id !== 'string' || !Array.isArray(savedServer.textChannels) || !Array.isArray(savedServer.voiceChannels)) {
        throw new Error('The server returned an invalid server.')
      }
      setServers((current) => isCreating
        ? [...current.filter(({ id }) => id !== savedServer.id), savedServer]
        : current.map((server) => server.id === savedServer.id ? savedServer : server))
      serversRef.current = isCreating
        ? [...serversRef.current.filter(({ id }) => id !== savedServer.id), savedServer]
        : serversRef.current.map((server) => server.id === savedServer.id ? savedServer : server)
      setServerDialogMode(null)
      if (isCreating) selectServer(savedServer)
      setNotice(isCreating ? `${savedServer.name} was created.` : `${savedServer.name} was renamed.`)
    } catch (error) {
      setNotice(`Could not save server: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsSavingServer(false)
    }
  }
  const deleteServer = async () => {
    if (!serverDeleteTarget || isDeletingServer) return
    const target = serverDeleteTarget
    setIsDeletingServer(true)
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      const result = await response.json() as { deleted?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'The server could not be deleted.')
      if (result.deleted !== true) throw new Error('The server did not confirm deletion.')
      setServers((current) => current.filter(({ id }) => id !== target.id))
      serversRef.current = serversRef.current.filter(({ id }) => id !== target.id)
      setChatMessages((current) => current.filter(({ serverId }) => serverId !== target.id))
      setVoiceMembers((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${target.id}:`))))
      if (activeServerIdRef.current === target.id) {
        const fallbackServer = servers.find(({ id }) => id !== target.id)
        if (fallbackServer) selectServer(fallbackServer)
      }
      setServerDeleteTarget(null)
      setNotice(`${target.name} and its channels and chat history were deleted.`)
    } catch (error) {
      setNotice(`Could not delete server: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setIsDeletingServer(false)
    }
  }
  const returnToChannels = (channel = 'welcome') => {
    setMobileSidebarOpen(false)
    setVoiceStageOpen(false)
    setDirectMessagesOpen(false)
    setActiveDmContact(null)
    setActiveChannel(channel)
    setCommunityTab(null)
  }
  const channelMessages = chatMessages.filter((item) => item.serverId === activeServerId && item.channel === activeChannel)
  const regularChannelMessages = channelMessages.filter((item) => item.kind !== 'welcome')
  const welcomeMessages = Array.from(new Map(channelMessages.filter((item) => item.kind === 'welcome').map((item) => [item.content, item])).values())
  const renderAttachments = (attachments: ChatAttachment[] = []) => attachments.length > 0 && <div className="chat-attachments">{attachments.map((attachment) => {
    const url = `/api/attachments/${encodeURIComponent(attachment.id)}`
    const fileSize = attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`
    if (attachment.mimeType.startsWith('image/')) {
      return <a className="chat-image-attachment" key={attachment.id} href={url} target="_blank" rel="noreferrer" aria-label={`Open image ${attachment.name}`}><img src={url} alt={attachment.name} loading="lazy" /><span>{attachment.name}</span></a>
    }
    return <a className="chat-file-attachment" key={attachment.id} href={url} download={attachment.name}><Paperclip size={16} /><span><strong>{attachment.name}</strong><small>{fileSize}</small></span><Download size={15} /></a>
  })}</div>
  const renderMessages = (items = channelMessages) => items.map((item) => {
    const isOwnMessage = item.authorId === user.id
    const canReact = item.kind !== 'welcome'
    const reactions = Object.entries(item.reactions ?? {}).filter(([, users]) => users.length > 0)
    return <article className={`chat-message ${item.kind === 'welcome' ? 'welcome-message' : ''} ${isOwnMessage ? 'chat-message-own' : 'chat-message-other'}`} key={item.id}>
      <div className={`chat-avatar ${item.kind !== 'welcome' && ((isOwnMessage && profilePicture) || item.avatarUrl) ? 'chat-avatar-picture' : ''}`}>{item.kind === 'welcome' ? '👋' : (isOwnMessage && profilePicture) || item.avatarUrl ? <img src={isOwnMessage && profilePicture ? profilePicture : item.avatarUrl} alt="" /> : item.author.slice(0, 1).toUpperCase()}</div>
      <div className="chat-message-content">
        <div className="chat-message-bubble">
          <div className="chat-message-meta">{item.kind !== 'welcome' ? renderUserNameplate(item.author, isOwnMessage, undefined, <button className="profile-name-button" onClick={() => openProfile(item.author, item.authorId)}>{item.author}</button>) : <button className="profile-name-button" onClick={() => openProfile(item.author, item.authorId)}>{item.author}</button>}<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          {item.content && <p>{item.content}</p>}
          {renderAttachments(item.attachments)}
        </div>
        {canReact && <div className="chat-reactions">
          {reactions.map(([emoji, users]) => <button key={emoji} className={`chat-reaction ${users.includes(reactionUserId.current) ? 'chat-reaction-selected' : ''}`} onClick={() => toggleMessageReaction(item.id, emoji)} aria-label={`${emoji}, ${users.length} reactions`} aria-pressed={users.includes(reactionUserId.current)}>{emoji}<span>{users.length}</span></button>)}
          <div className="message-reaction-picker-wrap">
            <button className="add-message-reaction" onClick={(event) => toggleReactionPicker(item.id, event)} aria-label="React to message" aria-expanded={reactionPickerFor === item.id}>☺</button>
            {reactionPickerFor === item.id && reactionPickerPosition && createPortal(<div ref={reactionPickerRef} className="emoji-picker message-emoji-picker" role="group" aria-label="Choose a reaction" style={reactionPickerPosition}>{chatEmojis.map((emoji) => <button key={emoji} type="button" onClick={() => toggleMessageReaction(item.id, emoji)} aria-label={`React with ${emoji}`}>{emoji}</button>)}</div>, document.body)}
          </div>
        </div>}
      </div>
    </article>
  })
  const renderComposer = () => <>
    {pendingAttachments.length > 0 && <div className="pending-attachments" aria-label="Attachments ready to send">{pendingAttachments.map((file, index) => <div className="pending-attachment" key={`${file.name}-${file.lastModified}-${index}`}><Paperclip size={13} /><span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB</small><button type="button" onClick={() => setPendingAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))} disabled={isSendingMessage} aria-label={`Remove ${file.name}`}>×</button></div>)}</div>}
    <div className="composer"><button className="composer-plus" type="button" onClick={() => attachmentInputRef.current?.click()} aria-label="Add attachment" disabled={isSendingMessage}><Plus size={18} /></button><input ref={attachmentInputRef} className="attachment-input" type="file" multiple onChange={(event) => { addAttachments(event.currentTarget.files); event.currentTarget.value = '' }} disabled={isSendingMessage} /><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendMessage() }} placeholder={`Message #${activeChannel}`} disabled={isSendingMessage} /><button className="composer-action" type="button" onClick={() => void sendMessage()} aria-label="Send message" disabled={isSendingMessage}><Send size={18} /></button><div className="emoji-picker-wrap"><button className="composer-action emoji-picker-toggle" type="button" onClick={() => setEmojiPickerOpen((open) => !open)} aria-label="Choose an emoji" aria-expanded={emojiPickerOpen} disabled={isSendingMessage}>☺</button>{emojiPickerOpen && <div className="emoji-picker" role="group" aria-label="Choose an emoji">{chatEmojis.map((emoji) => <button key={emoji} type="button" onClick={() => addEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}</div>}</div></div>
  </>
  const voiceStageParticipants = [
    {
      id: user.id,
      peerId: user.id,
      accountId: user.id,
      name: profileName,
      self: true,
      stream: localVideoStream,
      videoMode,
      muted: isMuted || isDeafened,
      speaking: isSpeaking,
      avatarUrl: profilePicture,
    },
    ...voicePeers.map((peer) => ({
      id: peer.userId ?? peer.id,
      peerId: peer.id,
      accountId: peer.userId,
      name: peer.author,
      self: false,
      stream: remoteStreams[peer.id] ?? null,
      videoMode: peer.videoMode ?? null,
      muted: peer.muted,
      speaking: Boolean(peer.speaking),
      avatarUrl: undefined,
    })),
  ]
  const orderedVoiceStageParticipants = [...voiceStageParticipants].sort((first, second) => {
    if (first.peerId === pinnedVoicePeerId) return -1
    if (second.peerId === pinnedVoicePeerId) return 1
    const videoPriority = (participant: typeof first) => participant.videoMode === 'screen' ? 0 : participant.videoMode === 'camera' ? 1 : 2
    return videoPriority(first) - videoPriority(second)
      || Number(second.speaking) - Number(first.speaking)
      || Number(first.self) - Number(second.self)
  })
  const featuredVoiceParticipant = orderedVoiceStageParticipants[0]
  const otherVoiceParticipants = orderedVoiceStageParticipants.slice(1)
  const pipVoiceParticipant = orderedVoiceStageParticipants.find((participant) => participant.videoMode && participant.stream)

  const startPipDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    pipDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top }
    pipDraggedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const movePip = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pipDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (!pipDraggedRef.current && Math.hypot(deltaX, deltaY) < 5) return
    pipDraggedRef.current = true
    const rect = event.currentTarget.getBoundingClientRect()
    const margin = 8
    const maxLeft = Math.max(margin, document.documentElement.clientWidth - rect.width - margin)
    const maxTop = Math.max(margin, document.documentElement.clientHeight - rect.height - margin)
    setPipPosition({
      left: Math.min(maxLeft, Math.max(margin, drag.left + deltaX)),
      top: Math.min(maxTop, Math.max(margin, drag.top + deltaY)),
    })
  }
  const stopPipDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (pipDragRef.current?.pointerId !== event.pointerId) return
    pipDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  if (servers.length === 0) {
    return <main className="server-onboarding">
      <section className="server-onboarding-card">
        <div className="auth-brand"><div className="brand-mark">R<span>×</span></div><span>REFORM</span></div>
        <div className="auth-icon"><Users size={20} /></div>
        <p className="eyebrow">YOUR GAMING COMMUNITY</p>
        <h1>{backendOnline ? 'Find your people.' : 'Connecting to REFORM…'}</h1>
        <p className="server-onboarding-copy">{backendOnline ? 'You’re not in any servers yet. Create a community or join one with an invitation code.' : 'Your servers will appear here once REFORM connects.'}</p>
        <div className="server-onboarding-actions">
          <button type="button" className="auth-submit" onClick={() => openServerDialog('create')} disabled={!backendOnline}><Plus size={16} /> Create a server</button>
        </div>
        <form className="server-join-form" onSubmit={(event) => void joinServer(event)}>
          <label htmlFor="server-invite-code">Have an invitation code?</label>
          <div><input id="server-invite-code" value={inviteCodeDraft} onChange={(event) => setInviteCodeDraft(event.target.value)} placeholder="Paste invite code" autoComplete="off" disabled={isJoiningServer || !backendOnline} /><button type="submit" disabled={!inviteCodeDraft.trim() || isJoiningServer || !backendOnline}>{isJoiningServer ? 'Joining…' : 'Join server'}</button></div>
        </form>
        {notice && <p className="server-onboarding-status" role="alert">{notice}</p>}
        {!backendOnline && <p className="server-onboarding-status" role="status">Connecting to the server service…</p>}
        <button type="button" className="onboarding-sign-out" onClick={() => void signOut()} disabled={isSigningOut}>{isSigningOut ? 'Signing out…' : `Sign out of ${profileName}`}</button>
      </section>
      {serverDialogMode === 'create' && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingServer) setServerDialogMode(null) }}><form className="channel-create-modal" role="dialog" aria-modal="true" aria-labelledby="server-dialog-title" onSubmit={(event) => void saveServer(event)}><button type="button" className="profile-modal-close" onClick={() => setServerDialogMode(null)} aria-label="Close server dialog" disabled={isSavingServer}>×</button><div className="channel-create-icon"><Swords size={20} /></div><h2 id="server-dialog-title">Create a server</h2><p>Start a gaming community with its own channels and chat history.</p><label className="channel-create-field">Server name<input autoFocus required maxLength={32} value={serverNameDraft} onChange={(event) => setServerNameDraft(event.target.value)} placeholder="e.g. Raid Squad" disabled={isSavingServer} /></label><div className="channel-create-actions"><button type="button" onClick={() => setServerDialogMode(null)} disabled={isSavingServer}>Cancel</button><button type="submit" disabled={!serverNameIsValid || isSavingServer || !backendOnline}>{isSavingServer ? 'Creating…' : 'Create server'}</button></div></form></div>}
    </main>
  }

  return (
    <main className={`app-shell ${mobileSidebarOpen ? 'mobile-sidebar-open ' : ''}${voiceStageOpen ? 'voice-stage-mode' : directMessagesOpen ? `dm-mode${activeDmContact ? ' dm-conversation-active' : ''}` : communityTab ? `community-mode community-${communityTab}` : activeChannel === 'welcome' ? 'welcome-mode' : 'chat-mode'}`}>
      <nav className="rail" aria-label="App navigation">
        <div className="brand-mark">R<span>×</span></div>
        <div className="rail-divider" />
        <button className={`server dm-rail-button ${directMessagesOpen ? 'server-active' : ''}`} aria-label="Direct Messages" aria-pressed={directMessagesOpen} title="Direct Messages" onClick={() => { setVoiceStageOpen(false); setDirectMessagesOpen(true); setActiveDmContact(null); setCommunityTab(null); setEmojiPickerOpen(false); setReactionPickerFor(null); setReactionPickerPosition(null) }}><MessageCircle size={20} /></button>
        <div className="rail-divider" />
        {servers.map((server, index) => <button key={server.id} className={`server ${server.id === activeServerId ? 'server-active' : ''} ${server.id !== 'reform' ? 'server-custom' : ''}`} style={server.id === 'reform' ? undefined : { backgroundColor: serverColors[index % serverColors.length] }} aria-label={server.name} aria-pressed={server.id === activeServerId} title={server.name} onClick={() => selectServer(server)}>{server.id === 'reform' ? <Swords size={20} /> : server.name.slice(0, 2).toUpperCase()}</button>)}
        <button className="server server-add" aria-label="Join or create a server" title="Join or create a server" onClick={openServerEntry}><Plus size={20} /></button>
        <div className="rail-bottom"><button className="rail-icon" onClick={() => setNotice('Settings panel is ready for preferences')}><Settings size={18} /></button></div>
      </nav>

      <button className="mobile-drawer-backdrop" type="button" aria-label="Close channel navigation" onClick={() => setMobileSidebarOpen(false)} tabIndex={mobileSidebarOpen ? 0 : -1} />
      <aside className={`sidebar ${mobileSidebarOpen ? 'sidebar-mobile-open' : ''}`}>
        <div className="server-heading">{directMessagesOpen ? <div className="dm-sidebar-heading"><strong>Direct Messages</strong><small>Your conversations</small></div> : <><button type="button" className="server-heading-toggle" onClick={() => setServerMenuOpen((open) => !open)} aria-expanded={serverMenuOpen}><span><strong>{activeServer.name}</strong><small>community hub</small></span><ChevronDown size={16} /></button>{serverMenuOpen && <div className="server-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setServerMenuOpen(false); openChannelCreation('text') }}>Create text channel</button><button type="button" role="menuitem" onClick={() => { setServerMenuOpen(false); openChannelCreation('voice') }}>Create voice lounge</button><button type="button" role="menuitem" onClick={() => void openServerInvite(activeServer)}>Invite people</button>{activeServer.ownerId === user.id && <button type="button" role="menuitem" onClick={() => openServerDialog('rename')}>Rename server</button>}{activeServer.id !== 'reform' && activeServer.ownerId === user.id && <button type="button" role="menuitem" className="server-menu-delete" onClick={() => { setServerMenuOpen(false); setServerDeleteTarget(activeServer) }}>Delete server</button>}</div>}</>}</div>
        <div className="profile-card">
          <button className={`avatar avatar-ember ${profilePicture ? 'avatar-picture' : ''}`} onClick={() => openProfile(profileName, user.id)} aria-label={`View ${profileName} profile`}>{profilePicture ? <img src={profilePicture} alt="" /> : profileName.slice(0, 2).toUpperCase()}</button><div className="profile-copy"><button className="profile-name-button" onClick={() => openProfile(profileName, user.id)}>{profileName}</button><span><i className="status-dot" /> Online</span></div><button type="button" className="profile-sign-out" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" disabled={isSigningOut}><LogOut size={15} /></button>
        </div>
        <div className="side-scroll">
          {directMessagesOpen ? <>
            <div className="side-section-title dm-list-title"><span>FRIENDS</span><span className="dm-online-count">{friendContacts.length}</span></div>
            {friendContacts.length ? friendContacts.map((contact) => <button key={contact.id} className={`channel dm-contact ${activeDmContact?.id === contact.id ? 'channel-active' : ''}`} onClick={() => openDirectMessage(contact)} aria-current={activeDmContact?.id === contact.id ? 'page' : undefined}><span className={`dm-contact-avatar ${contact.avatarUrl ? 'avatar-picture' : ''}`}>{contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : contact.name.slice(0, 1).toUpperCase()}</span><span className="dm-contact-name">{contact.name}</span>{contact.online ? <i className="dm-online-dot" title="Online" /> : <i className="dm-offline-dot" title="Offline" />}</button>) : <p className="dm-empty-list">Add a community member as a friend to keep them here, even when they’re offline.</p>}
            <div className="side-section-title dm-list-title"><span>CONVERSATIONS</span><span className="dm-online-count">{onlineMembers.filter(({ id }) => id !== reactionUserId.current).length} online</span></div>
            {conversationContacts.length ? conversationContacts.map((contact) => <button key={contact.id} className={`channel dm-contact ${activeDmContact?.id === contact.id ? 'channel-active' : ''}`} onClick={() => openDirectMessage(contact)} aria-current={activeDmContact?.id === contact.id ? 'page' : undefined}><span className={`dm-contact-avatar ${contact.avatarUrl ? 'avatar-picture' : ''}`}>{contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : contact.name.slice(0, 1).toUpperCase()}</span><span className="dm-contact-name">{contact.name}</span>{contact.streak?.streak ? <span className="dm-contact-streak" title={`${contact.streak.streak} day shared streak`}>🔥{contact.streak.streak}</span> : contact.online ? <i className="dm-online-dot" title="Online" /> : null}</button>) : <p className="dm-empty-list">Members who are online and your recent conversations will show here.</p>}
          </> : <>
          <div className="side-section-title"><span>START HERE</span></div>
          <button key="welcome" onClick={() => returnToChannels('welcome')} className={`channel ${activeChannel === 'welcome' && !communityTab ? 'channel-active' : ''}`}><Sparkles size={17} /><span>welcome</span></button>
          <div className="side-section-title"><span>TEXT CHANNELS</span><button className="section-add" aria-label="Create text channel" onClick={() => openChannelCreation('text')}><Plus size={15} /></button></div>
          {textChannelList.map((channel) => <div className="text-channel-row" key={channel.label}><button onClick={() => returnToChannels(channel.label)} className={`channel ${activeChannel === channel.label && !communityTab ? 'channel-active' : ''}`}><MessageCircle size={17} /><span>{channel.label}</span>{(channel.count ?? 0) > 0 && <b>{channel.count}</b>}</button>{channel.createdBy === user.id && <button type="button" className="text-channel-settings" aria-label={`Settings for ${channel.label}`} title={`Settings for ${channel.label}`} onClick={() => openTextChannelSettings(channel)}><Settings size={14} /></button>}</div>)}
          <div className="side-section-title voice-title"><span>VOICE LOUNGES</span><button className="section-add" aria-label="Create voice channel" onClick={() => openChannelCreation('voice')}><Plus size={15} /></button></div>
          {voiceChannelList.map((channel) => <div className="voice-channel-row" key={channel.label}><button onClick={() => void joinVoice(channel.label)} className={`channel voice-channel ${activeVoice === channel.label && activeVoiceServerRef.current === activeServerId ? 'voice-active' : ''}`}><Volume2 size={16} /><span>{channel.label}</span><Users size={14} className="voice-users" /><b>{(voiceMembers[voiceRoomKey(activeServerId, channel.label)] ?? []).length}</b></button><button type="button" className={`voice-chat-button ${activeVoiceChatLabel === channel.label ? 'voice-chat-button-active' : ''}`} onClick={() => returnToChannels(`voice:${channel.label}`)} aria-label={`Open ${channel.label} lounge chat`} title={`Open ${channel.label} chat`}><MessageCircle size={15} /></button></div>)}
          {activeVoice && <div className="voice-connected"><div className="voice-connected-head"><span><i className="status-dot" /> Voice channel joined</span><span className={`voice-signal voice-signal-${voiceSignal}`} title={`Voice connection: ${voiceSignal}`} aria-label={`Voice connection ${voiceSignal}`}><Wifi size={13} /><span className="signal-bars"><i /><i /><i /></span><small>{voiceSignal === 'unknown' ? voicePeers.length ? 'Connecting' : 'Ready' : voiceSignal === 'fair' ? 'Fair' : voiceSignal}</small></span><button onClick={disconnectVoice} aria-label="Leave voice channel">×</button></div><strong>{activeVoice}</strong><span className={isMuted || isDeafened ? 'voice-muted-label' : ''}>{isDeafened ? 'Deafened' : isMuted ? 'Microphone muted' : 'Microphone on'}</span><div className="voice-member-list"><div className="voice-member"><span className={`voice-member-avatar ${profilePicture ? 'avatar-picture' : ''} ${isSpeaking ? 'voice-speaking' : ''}`}>{profilePicture ? <img src={profilePicture} alt="" /> : 'J'}</span><span className="voice-member-name-row">{renderUserNameplate(profileName, true, true, <button className="profile-name-button" onClick={() => openProfile(profileName, user.id)}>{profileName} (you)</button>)}</span>{isMuted || isDeafened ? <MicOff size={12} /> : <Mic size={12} />}</div>{voicePeers.map((peer) => <div className="voice-member" key={peer.id}><span className={`voice-member-avatar ${peer.speaking ? 'voice-speaking' : ''}`}>{peer.author.slice(0, 1).toUpperCase()}</span><span className="voice-member-name-row">{renderUserNameplate(peer.author, false, true, <button className="profile-name-button" onClick={() => openProfile(peer.author, peer.id)}>{peer.author}</button>)}</span>{peer.muted ? <MicOff size={12} /> : <Mic size={12} />}</div>)}</div><div className="voice-control-row"><button className={`voice-control ${isMuted || isDeafened ? 'voice-control-off' : ''}`} onClick={toggleMicrophone} aria-label={isMuted || isDeafened ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={isMuted || isDeafened} title={isMuted || isDeafened ? 'Unmute microphone' : 'Mute microphone'}>{isMuted || isDeafened ? <MicOff size={15} /> : <Mic size={15} />}</button><button className={`voice-control ${isDeafened ? 'voice-control-off' : ''}`} onClick={toggleDeafen} aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'} aria-pressed={isDeafened} title={isDeafened ? 'Undeafen audio' : 'Deafen audio'}>{isDeafened ? <VolumeX size={15} /> : <Headphones size={15} />}</button><button className="disconnect-button" onClick={disconnectVoice}><Headphones size={13} /> Disconnect</button></div></div>}
          <div className="side-section-title"><span>COMMUNITY</span><button className="section-add" aria-label="Add community space" onClick={() => setNotice('Community spaces can be added by server moderators')}><Plus size={15} /></button></div>
          <button className={`channel ${communityTab === 'leaderboard' ? 'channel-active' : ''}`} onClick={() => openCommunityTab('leaderboard')}><Trophy size={17} /><span>leaderboard</span></button>
          <button className={`channel ${communityTab === 'quests' ? 'channel-active' : ''}`} onClick={() => openCommunityTab('quests')}><Zap size={17} /><span>quests</span></button>
          </>}
        </div>
        <div className="channel-tools">
          <section className={`channel-tools-panel ${channelToolsOpen ? 'channel-tools-panel-open' : ''}`} aria-label="Voice settings" aria-hidden={!channelToolsOpen} inert={!channelToolsOpen}>
            <div className="channel-tools-title"><strong>Voice settings</strong><button onClick={() => setChannelToolsOpen(false)} aria-label="Close voice settings"><X size={16} /></button></div>
              <div className="profile-picture-setting"><div className={`profile-picture-preview ${profilePicture ? 'avatar-picture' : ''}`}>{profilePicture ? <img src={profilePicture} alt="Current profile" /> : profileName.slice(0, 2).toUpperCase()}</div><div><strong>{profileName}</strong><span>Profile picture</span></div><label className="profile-picture-upload"><ImagePlus size={15} /> Change<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { uploadProfilePicture(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>{profilePicture && <button className="profile-picture-remove" onClick={() => setProfilePicture(null)}>Remove</button>}</div>
              <label className="device-setting profile-name-setting">Username<input value={profileNameDraft} maxLength={32} onChange={(event) => setProfileNameDraft(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void saveProfileName()} /></label>
              <button className="profile-name-save" type="button" onClick={() => void saveProfileName()} disabled={profileNameDraft.trim() === profileName || isSavingProfileName}>{isSavingProfileName ? 'Saving…' : profileNameDraft.trim() === profileName ? 'Username saved' : 'Save username'}</button>
            <div className="tool-actions">
              <button disabled={!activeVoice || videoMode === 'screen'} onClick={() => videoMode === 'camera' ? void stopVideo() : void startCamera()}><Camera size={15} />{videoMode === 'camera' ? 'Turn camera off' : 'Open camera'}</button>
              <button disabled={!activeVoice || videoMode === 'camera'} onClick={() => videoMode === 'screen' ? void stopVideo() : void startScreenShare()}><ScreenShare size={15} />{videoMode === 'screen' ? 'Stop sharing' : 'Share screen'}</button>
            </div>
            <label className="device-setting">Microphone
              <select value={selectedMicId} onChange={(event) => void changeMicrophone(event.target.value)}>{audioInputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select>
            </label>
            <label className="volume-setting"><span>Mic volume <b>{micVolume}%</b></span><input type="range" min="0" max="200" value={micVolume} onChange={(event) => setMicVolume(Number(event.target.value))} /></label>
            <label className="device-setting">Output device
              <select value={selectedOutputId} onChange={(event) => void setOutputDevice(event.target.value)}><option value="">System default</option>{audioOutputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Output ${index + 1}`}</option>)}</select>
            </label>
            <label className="volume-setting"><span>Output volume <b>{outputVolume}%</b></span><input type="range" min="0" max="100" value={outputVolume} onChange={(event) => setOutputVolume(Number(event.target.value))} /></label>
            {!activeVoice && <p className="tools-hint">Join a voice channel to use camera or screen share.</p>}
          </section>
          <button className={`channel-tools-toggle ${channelToolsOpen ? 'tools-open' : ''}`} onClick={() => setChannelToolsOpen((open) => !open)} aria-label="Open channel settings" aria-expanded={channelToolsOpen}><Menu size={19} /><span>Voice &amp; settings</span><Settings size={15} /></button>
        </div>
      </aside>

      {Object.entries(remoteStreams).map(([id, stream]) => <audio key={id} className="remote-voice-audio" autoPlay muted={id.startsWith('dm-call:') ? false : isDeafened} ref={(element) => { if (element && element.srcObject !== stream) element.srcObject = stream }} />)}
      {directCall && <section className={`dm-call-banner dm-call-${directCall.status}`} role="status" aria-live="polite">
        <span className="dm-call-avatar">{directCall.contactName.slice(0, 1).toUpperCase()}</span>
        <span className="dm-call-copy"><strong>{directCall.contactName}</strong><small>{directCall.status === 'starting' ? 'Requesting microphone…' : directCall.status === 'ringing' ? directCall.direction === 'incoming' ? 'Incoming voice call' : 'Calling…' : directCall.status === 'connecting' ? 'Connecting audio…' : 'Voice call connected'}</small></span>
        {directCall.direction === 'incoming' && directCall.status === 'ringing' ? <>
          <button type="button" className="dm-call-accept" onClick={() => void acceptDirectCall()} aria-label={`Answer ${directCall.contactName}'s call`}><Phone size={16} /><span>Answer</span></button>
          <button type="button" className="dm-call-end" onClick={declineDirectCall} aria-label={`Decline ${directCall.contactName}'s call`}><PhoneOff size={16} /><span>Decline</span></button>
        </> : <>
          {directCall.status === 'active' && <button type="button" className={`dm-call-mute ${isDirectCallMuted ? 'dm-call-muted' : ''}`} onClick={toggleDirectCallMute} aria-label={isDirectCallMuted ? 'Unmute microphone' : 'Mute microphone'} title={isDirectCallMuted ? 'Unmute microphone' : 'Mute microphone'}>{isDirectCallMuted ? <MicOff size={16} /> : <Mic size={16} />}</button>}
          <button type="button" className="dm-call-end" onClick={endDirectCall} aria-label={directCall.status === 'ringing' ? 'Cancel call' : 'End call'}><PhoneOff size={16} /><span>{directCall.status === 'ringing' || directCall.status === 'starting' ? 'Cancel' : 'End call'}</span></button>
        </>}
      </section>}
      {activeVoice && !voiceStageOpen && pipVoiceParticipant && <button type="button" className="voice-picture-in-picture" style={pipPosition ? { left: pipPosition.left, top: pipPosition.top, right: 'auto', bottom: 'auto' } : undefined} onPointerDown={startPipDrag} onPointerMove={movePip} onPointerUp={stopPipDrag} onPointerCancel={(event) => { pipDragRef.current = null; pipDraggedRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onLostPointerCapture={() => { pipDragRef.current = null }} onClick={(event) => { if (pipDraggedRef.current) { pipDraggedRef.current = false; event.preventDefault(); return } setVoiceStageOpen(true) }} aria-label={`Return to ${activeVoice} voice lounge. Drag to reposition.`} title={`Drag to move · Return to ${activeVoice}`}>
        <video autoPlay muted playsInline ref={(element) => { if (element && element.srcObject !== pipVoiceParticipant.stream) element.srcObject = pipVoiceParticipant.stream }} />
        <span className="voice-picture-in-picture-label"><span><strong>{pipVoiceParticipant.name}{pipVoiceParticipant.self ? ' (you)' : ''}</strong><small>{pipVoiceParticipant.videoMode === 'screen' ? 'Screen sharing' : 'Camera on'} · Return to lounge</small></span><Maximize2 size={15} /></span>
      </button>}
      {activeVoice && !voiceStageOpen && <section className="mobile-voice-overlay" aria-label={`${activeVoice} voice controls`}>
        {pipVoiceParticipant?.stream && <video autoPlay muted playsInline ref={(element) => { if (element && element.srcObject !== pipVoiceParticipant.stream) element.srcObject = pipVoiceParticipant.stream }} />}
        <div className="mobile-voice-overlay-heading"><span className="mobile-voice-live-dot" /><span><strong>{activeVoice}</strong><small>{voicePeers.length + 1} {voicePeers.length === 0 ? 'member' : 'members'} · {isDeafened ? 'Deafened' : isMuted ? 'Muted' : 'Connected'}</small></span><button type="button" onClick={() => setVoiceStageOpen(true)} aria-label="Open voice lounge" title="Open voice lounge"><Maximize2 size={16} /></button></div>
        <div className="mobile-voice-overlay-controls">
          <button type="button" className={isMuted || isDeafened ? 'voice-control-off' : ''} onClick={toggleMicrophone} aria-label={isMuted || isDeafened ? 'Unmute microphone' : 'Mute microphone'}>{isMuted || isDeafened ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button type="button" className={isDeafened ? 'voice-control-off' : ''} onClick={toggleDeafen} aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}>{isDeafened ? <VolumeX size={17} /> : <Headphones size={17} />}</button>
          <button type="button" onClick={() => returnToChannels(`voice:${activeVoice}`)} aria-label={`Open ${activeVoice} lounge chat`}><MessageCircle size={17} /></button>
          <button type="button" className="mobile-voice-leave" onClick={disconnectVoice} aria-label="Leave voice lounge"><X size={17} /></button>
        </div>
      </section>}

      <section className="content">
        <header className="topbar"><div className="channel-title">{activeDmContact && <button className="mobile-back-button" type="button" onClick={() => setActiveDmContact(null)} aria-label="Back to direct messages"><ChevronLeft size={20} /></button>}{voiceStageOpen ? <Headphones size={19} /> : activeDmContact ? <Users size={19} /> : directMessagesOpen ? <MessageCircle size={19} /> : communityTab ? communityTab === 'leaderboard' ? <Trophy size={19} /> : <Zap size={19} /> : <MessageCircle size={19} />}<strong>{voiceStageOpen ? activeVoice ?? 'Joining voice lounge' : activeDmContact ? activeDmContact.name : directMessagesOpen ? 'Direct Messages' : communityTab ? communityTab === 'leaderboard' ? 'leaderboard' : 'quests' : activeVoiceChatLabel ? `${activeVoiceChatLabel} chat` : activeChannel}</strong><span className="topbar-separator" /><span className="channel-topic">{voiceStageOpen ? `${voiceStageParticipants.length} members · live voice, camera, and screen sharing` : activeDmContact ? `🔥 ${directMessageStreak.streak} day shared conversation streak${directMessageStreak.activeToday ? ' · matched today' : ''}` : directMessagesOpen ? 'Private conversations with your community.' : communityTab ? communityTab === 'leaderboard' ? 'See how you stack up with the community.' : 'Complete activities to earn XP and level up.' : channelTopics[activeChannel]}</span><span className={`backend-status ${backendOnline ? 'backend-online' : ''}`}>{backendOnline ? 'Live' : 'Offline'}</span></div><div className="top-actions">{voiceStageOpen && <button type="button" className="voice-stage-minimize" onClick={() => setVoiceStageOpen(false)} aria-label="Minimize voice stage" title="Minimize voice stage"><X size={18} /></button>}<button className="mobile-nav-button" type="button" onClick={() => setMobileSidebarOpen((open) => !open)} aria-label={mobileSidebarOpen ? 'Close channels' : 'Open channels'} aria-expanded={mobileSidebarOpen}>{mobileSidebarOpen ? <X size={19} /> : <Menu size={19} />}</button><button className="icon-button" onClick={() => setNotice(`${onlineMembers.length} members online`)} aria-label="Show members"><Users size={19} /></button>{activeTextChannel?.createdBy === user.id && !activeDmContact && !directMessagesOpen && !communityTab && <button type="button" className="icon-button channel-header-settings" onClick={() => openTextChannelSettings(activeTextChannel)} aria-label={`Edit or delete ${activeTextChannel.label}`} title={`Edit or delete #${activeTextChannel.label}`}><Settings size={18} /></button>}<button className="icon-button" onClick={() => setNotice('REFORM help center')} aria-label="Open help"><CircleHelp size={19} /></button><div className="search"><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && setNotice(searchTerm ? `Search results for “${searchTerm}”` : 'Type something to search')} placeholder="Search" /><Search size={16} /></div></div></header>
        <div className={`feed ${directMessagesOpen ? 'dm-feed' : activeChannel === 'welcome' ? 'welcome-feed' : 'chat-feed'}`}>
          {voiceStageOpen ? <section className="voice-stage-view">
            <header className="voice-stage-heading"><div><p className="eyebrow">LIVE VOICE LOUNGE</p><h1>{activeVoice ?? 'Connecting to voice lounge…'}</h1><span>{voiceStageParticipants.length} {voiceStageParticipants.length === 1 ? 'member' : 'members'} · Click any tile to bring that member to the front.</span></div><span className={`voice-stage-signal voice-signal-${voiceSignal}`}><Wifi size={14} /> {voiceSignal === 'unknown' ? 'Voice connected' : `${voiceSignal} connection`}</span></header>
            <div className="voice-stage">
              {featuredVoiceParticipant && <article className={`voice-stage-feature ${pinnedVoicePeerId === featuredVoiceParticipant.peerId ? 'voice-stage-pinned' : ''} ${featuredVoiceParticipant.speaking ? 'voice-stage-speaking' : ''}`}>
                <button type="button" className="voice-stage-tile" onClick={() => setPinnedVoicePeerId((current) => current === featuredVoiceParticipant.peerId ? null : featuredVoiceParticipant.peerId)} aria-label={`Pin ${featuredVoiceParticipant.name} to the front`}>
                  {featuredVoiceParticipant.videoMode && featuredVoiceParticipant.stream ? <video autoPlay muted playsInline ref={(element) => { if (element && element.srcObject !== featuredVoiceParticipant.stream) element.srcObject = featuredVoiceParticipant.stream }} /> : <span className={`voice-stage-avatar ${featuredVoiceParticipant.avatarUrl ? 'avatar-picture' : ''}`}>{featuredVoiceParticipant.avatarUrl ? <img src={featuredVoiceParticipant.avatarUrl} alt="" /> : featuredVoiceParticipant.name.slice(0, 1).toUpperCase()}</span>}
                  {featuredVoiceParticipant.videoMode && !featuredVoiceParticipant.stream && <span className="voice-stage-video-pending">Connecting video…</span>}
                  <span className="voice-stage-tile-info"><span className="voice-stage-member-copy">{renderUserNameplate(featuredVoiceParticipant.name, featuredVoiceParticipant.self, true, <strong>{featuredVoiceParticipant.name}{featuredVoiceParticipant.self ? ' (you)' : ''}</strong>)}<small>{featuredVoiceParticipant.videoMode === 'screen' ? 'Sharing screen' : featuredVoiceParticipant.videoMode === 'camera' ? 'Camera on' : featuredVoiceParticipant.speaking ? 'Speaking' : 'In voice'}</small></span>{featuredVoiceParticipant.muted ? <MicOff size={16} aria-label="Muted" /> : <Mic size={16} aria-label="Microphone on" />}</span>
                </button>
                {!featuredVoiceParticipant.self && <button type="button" className="voice-stage-profile" onClick={() => openProfile(featuredVoiceParticipant.name, featuredVoiceParticipant.accountId)} aria-label={`View ${featuredVoiceParticipant.name} profile`}><Users size={14} /> Profile</button>}
              </article>}
              {otherVoiceParticipants.length > 0 && <div className="voice-stage-participant-list" aria-label="Other voice lounge members">{otherVoiceParticipants.map((participant) => <article key={participant.peerId} className={`voice-stage-participant ${pinnedVoicePeerId === participant.peerId ? 'voice-stage-pinned' : ''} ${participant.speaking ? 'voice-stage-speaking' : ''}`}>
                <button type="button" className="voice-stage-tile" onClick={() => setPinnedVoicePeerId((current) => current === participant.peerId ? null : participant.peerId)} aria-label={`Bring ${participant.name} to the front`}>
                  {participant.videoMode && participant.stream ? <video autoPlay muted playsInline ref={(element) => { if (element && element.srcObject !== participant.stream) element.srcObject = participant.stream }} /> : <span className={`voice-stage-avatar ${participant.avatarUrl ? 'avatar-picture' : ''}`}>{participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : participant.name.slice(0, 1).toUpperCase()}</span>}
                  {participant.videoMode && !participant.stream && <span className="voice-stage-video-pending">Connecting video…</span>}
                  <span className="voice-stage-tile-info"><span className="voice-stage-member-copy">{renderUserNameplate(participant.name, participant.self, true, <strong>{participant.name}</strong>)}<small>{participant.videoMode === 'screen' ? 'Sharing screen' : participant.videoMode === 'camera' ? 'Camera on' : participant.speaking ? 'Speaking' : 'In voice'}</small></span>{participant.muted ? <MicOff size={15} aria-label="Muted" /> : <Mic size={15} aria-label="Microphone on" />}</span>
                </button>
                <button type="button" className="voice-stage-profile" onClick={() => openProfile(participant.name, participant.accountId)} aria-label={`View ${participant.name} profile`}><Users size={14} /> Profile</button>
              </article>)}</div>}
            </div>
            <footer className="voice-stage-controls" aria-label="Voice lounge controls">
              <button type="button" className={isMuted || isDeafened ? 'voice-control-off' : ''} onClick={toggleMicrophone} aria-label={isMuted || isDeafened ? 'Unmute microphone' : 'Mute microphone'}><Mic size={17} /> {isMuted || isDeafened ? 'Unmute' : 'Mute'}</button>
              <button type="button" className={isDeafened ? 'voice-control-off' : ''} onClick={toggleDeafen} aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}><Headphones size={17} /> {isDeafened ? 'Undeafen' : 'Deafen'}</button>
              <button type="button" onClick={() => videoMode === 'camera' ? void stopVideo() : void startCamera()} disabled={videoMode === 'screen'}><Camera size={17} /> {videoMode === 'camera' ? 'Stop camera' : 'Camera'}</button>
              <button type="button" onClick={() => videoMode === 'screen' ? void stopVideo() : void startScreenShare()} disabled={videoMode === 'camera'}><ScreenShare size={17} /> {videoMode === 'screen' ? 'Stop sharing' : 'Share screen'}</button>
              <button type="button" className="voice-stage-leave" onClick={disconnectVoice}><Headphones size={17} /> Leave lounge</button>
            </footer>
          </section> : directMessagesOpen && !activeDmContact ? <section className="dm-inbox-view">
            <header className="community-view-header"><div className="community-view-icon"><MessageCircle size={21} /></div><div><p className="eyebrow">YOUR COMMUNITY</p><h1>Direct Messages</h1><span>Pick up a private conversation, message a friend, or start chatting with someone online.</span></div></header>
            <div className="dm-inbox-list">{directContacts.map((contact) => <button key={contact.id} type="button" className="dm-inbox-card" onClick={() => openDirectMessage(contact)}><span className={`dm-contact-avatar dm-inbox-avatar ${contact.avatarUrl ? 'avatar-picture' : ''}`}>{contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : contact.name.slice(0, 1).toUpperCase()}</span><span className="dm-inbox-copy"><strong>{contact.name}<i className={contact.online ? 'dm-online-dot' : 'dm-offline-dot'} /></strong><span>{contact.lastMessage?.content ?? (contact.online ? 'Online now · start a conversation' : friends.some(({ id }) => id === contact.id) ? 'Friend · start a conversation' : 'Open direct conversation')}</span></span>{contact.streak?.streak ? <span className="dm-contact-streak">🔥 {contact.streak.streak} day streak</span> : <MessageCircle size={17} />}</button>)}{directContacts.length === 0 && <div className="dm-inbox-empty"><Users size={23} /><strong>No conversations yet</strong><span>Online members and your friends will show up here.</span></div>}</div>
          </section> : activeDmContact ? <section className="full-chat dm-conversation">
            <div className="dm-conversation-header"><div className={`dm-large-avatar ${activeDmContact.avatarUrl ? 'avatar-picture' : ''}`}>{activeDmContact.avatarUrl ? <img src={activeDmContact.avatarUrl} alt="" /> : activeDmContact.name.slice(0, 1).toUpperCase()}</div><h1>{activeDmContact.name}</h1><p>{activeDmContact.online ? 'Online now · direct conversation' : 'Direct conversation'}</p><button type="button" className="dm-call-start" onClick={() => void startDirectCall()} disabled={!backendOnline || !activeDmContact.online || directCall !== null} title={!activeDmContact.online ? 'This member is offline' : 'Start a voice call'}><Phone size={15} /> Voice call</button><div className={`dm-streak-card ${directMessageStreak.streak ? 'dm-streak-active' : ''}`}><span className="dm-streak-flame">🔥</span><div><strong>{directMessageStreak.streak} day shared streak</strong><span>{directMessageStreak.activeToday ? 'You both checked in today. Keep it going tomorrow!' : directMessageStreak.streak ? 'Both of you need to message today to keep the streak alive.' : 'Send a message each day, and match with each other to start a streak.'}</span></div></div></div>
            <div className="full-chat-messages dm-messages" aria-live="polite">{directMessages.map((item) => {
              const ownMessage = item.fromId === reactionUserId.current
              const avatar = ownMessage ? profilePicture : item.avatarUrl
              return <article className={`chat-message ${ownMessage ? 'chat-message-own' : 'chat-message-other'}`} key={item.id}><div className={`chat-avatar ${avatar ? 'chat-avatar-picture' : ''}`}>{avatar ? <img src={avatar} alt="" /> : item.fromName.slice(0, 1).toUpperCase()}</div><div className="chat-message-content"><div className="chat-message-bubble"><div className="chat-message-meta"><strong>{ownMessage ? profileName : item.fromName}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{item.content}</p></div></div></article>
            })}{directMessages.length === 0 && <p className="dm-first-message">This is the start of your conversation with {activeDmContact.name}. Say hi to begin.</p>}</div>
            <div className="composer dm-composer"><input value={directMessageDraft} onChange={(event) => setDirectMessageDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendDirectMessage() }} placeholder={`Message ${activeDmContact.name}`} disabled={isSendingDirectMessage || !backendOnline} /><button className="composer-action" type="button" onClick={() => void sendDirectMessage()} aria-label={`Send direct message to ${activeDmContact.name}`} disabled={isSendingDirectMessage || !backendOnline || !directMessageDraft.trim()}><Send size={18} /></button></div>
          </section> : communityTab === 'leaderboard' ? <section className="community-view leaderboard-view">
            <header className="community-view-header"><div className="community-view-icon"><Trophy size={21} /></div><div><p className="eyebrow">COMMUNITY RANKINGS</p><h1>Leaderboard</h1><span>Players will be ranked here as they earn XP.</span></div></header>
            {currentRank > 0 && <section className="your-rank-card"><div className="your-rank-number">#{currentRank}</div><div className="your-rank-copy"><strong>Your current rank</strong><span>{profileName} · Level {currentLevel}</span></div><div className="your-rank-xp">{progress.xp.toLocaleString()} XP earned</div></section>}
            <div className="leaderboard-table"><div className="leaderboard-row leaderboard-table-head"><span>RANK</span><span>PLAYER</span><span>LEVEL</span><span>XP</span></div>{rankedPlayers.length === 0 && <p className="leaderboard-empty">No players ranked yet. Earn XP to appear here.</p>}{rankedPlayers.map((player, index) => {
              const crownTier = ['gold', 'silver', 'bronze'][index]
              const crownTitle = ['Gold', 'Silver', 'Bronze'][index]
              return <div className={`leaderboard-row ${player.name === profileName ? 'leaderboard-self' : ''} ${index < 3 ? `leaderboard-place-${crownTier}` : ''}`} key={player.name}><span className="leaderboard-position">{index < 3 ? ['🥇', '🥈', '🥉'][index] : `#${index + 1}`}</span><span className="leaderboard-player"><i>{player.name.slice(0, 1)}</i><span className="leaderboard-identity"><button type="button" className={`leaderboard-player-name ${index < 3 ? `leaderboard-name-border name-border-${crownTier}` : ''}`} onClick={() => openProfile(player.name)} aria-label={`View ${player.name}'s profile`}><span>{player.name}</span>{player.name === profileName && <small>YOU</small>}</button>{index < 3 && <span className={`leaderboard-nameplate nameplate-${crownTier}`}><Crown size={11} /><span>{crownTitle} Crown</span></span>}</span></span><span>Lv. {player.level}</span><b>{player.xp.toLocaleString()} XP</b></div>
            })}</div>
          </section> : communityTab === 'quests' ? <section className="community-view quests-view">
            <header className="community-view-header"><div className="community-view-icon quest-icon"><Zap size={21} /></div><div><p className="eyebrow">PLAY · CHAT · PROGRESS</p><h1>Quests</h1><span>Take part in the community to earn XP and level up.</span></div></header>
            <section className="quest-level-card"><div className="quest-level-top"><div><span>YOUR LEVEL</span><strong>Level {currentLevel}</strong></div><b>{currentLevelXp} / 500 XP</b></div><div className="quest-level-track"><span style={{ width: `${currentLevelXp / 5}%` }} /></div><p>Claim completed quests to earn XP. Every 500 XP unlocks a level.</p></section>
            {(['daily', 'weekly'] as const).map((period) => <section className="quest-group" key={period}><div className="quest-group-heading"><h2>{period === 'daily' ? 'Daily tasks' : 'Weekly tasks'}</h2><span>{period === 'daily' ? 'Resets every day' : 'Resets every Monday'}</span></div><div className="quest-list">{questItems.filter((quest) => quest.period === period).map((quest) => {
              const amount = Math.min(quest.progress, quest.goal)
              const complete = amount >= quest.goal
              const claimKey = `${period === 'daily' ? progress.dayKey : progress.weekKey}:${quest.id}`
              const claimed = progress.claimed.includes(claimKey)
              return <article className="quest-card" key={quest.id}><div className="quest-card-icon">{quest.icon}</div><div className="quest-card-info"><div className="quest-card-title"><strong>{quest.title}</strong><span>+{quest.reward} XP</span></div><p>{quest.detail}</p><div className="quest-progress-label"><span>{complete ? 'Complete' : 'Progress'}</span><b>{amount}/{quest.goal}</b></div><div className="quest-progress-track"><span style={{ width: `${amount / quest.goal * 100}%` }} /></div></div><button className={`quest-claim ${claimed ? 'quest-claimed' : ''}`} disabled={!complete || claimed} onClick={() => claimQuest(period, quest.id, quest.reward, complete)}>{claimed ? 'Claimed' : complete ? 'Claim XP' : 'In progress'}</button></article>
            })}</div></section>)}
          </section> : activeChannel === 'welcome' ? <>
          <section className="hero-row"><div><p className="eyebrow"><Sparkles size={14} /> YOUR GAMING HQ</p><h1>Welcome back, <em>{profileName.split(/\s+/)[0]}.</em></h1><p className="hero-copy">Your community starts here.</p></div><div className="streak"><div className="flame"><Zap size={16} /></div><div><strong>Level {currentLevel}</strong><span>{progress.xp} XP · Starting fresh</span></div></div></section>
          <section className="welcome-notifications"><div><span className="eyebrow"><Users size={14} /> COMMUNITY GREETINGS</span><h2>Welcome new members</h2></div><div className="welcome-message-list">{renderMessages(welcomeMessages)}{welcomeMessages.length === 0 && <p className="chat-empty">New member welcomes will appear here.</p>}</div></section>
          <section className="quick-grid"><div className="section-label"><span>ACTIVE TRACKERS</span></div><div className="welcome-empty-state"><Gamepad2 size={20} /><strong>No games tracked yet</strong><span>Tracked games will appear here when available.</span></div></section>
          <section className="activity-section"><div className="section-label"><span>RECENT ACTIVITY</span></div><div className="activity-list activity-empty-state"><span>No activity yet</span><small>Community activity will appear here as players chat and progress.</small></div></section>
          <section className="welcome-chat"><div className="section-label"><span><MessageCircle size={13} /> welcome chat</span><span>{regularChannelMessages.length} messages</span></div><div className="welcome-chat-messages" aria-live="polite">{renderMessages(regularChannelMessages)}{regularChannelMessages.length === 0 && <p className="chat-empty">Say hello to the community.</p>}</div>{renderComposer()}</section>
          </> : <section className="full-chat"><div className="full-chat-intro"><MessageCircle size={25} /><h1>{activeVoiceChatLabel ? `${activeVoiceChatLabel} lounge chat` : activeChannel}</h1><p>{channelTopics[activeChannel]}</p><span>{activeVoiceChatLabel ? `Voice lounge chat for ${activeVoiceChatLabel}.` : `This is the beginning of #${activeChannel}.`}</span></div><div className="full-chat-messages" aria-live="polite">{renderMessages()}{channelMessages.length === 0 && <p className="chat-empty">{backendOnline ? 'No messages yet. Start the conversation.' : 'Connecting to chat backend…'}</p>}</div>{renderComposer()}</section>}
        </div>
      </section>

      {serverEntryOpen && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isJoiningServer) setServerEntryOpen(false) }}><section className="channel-create-modal server-entry-modal" role="dialog" aria-modal="true" aria-labelledby="server-entry-title"><button type="button" className="profile-modal-close" onClick={() => setServerEntryOpen(false)} aria-label="Close join or create server dialog" disabled={isJoiningServer}>×</button><div className="channel-create-icon"><Users size={20} /></div><h2 id="server-entry-title">Join or create a server</h2><p>Join your friends with an invite code, or start a community of your own.</p><form className="server-join-form" onSubmit={(event) => void joinServer(event)}><label htmlFor="server-entry-invite">Invitation code</label><div><input id="server-entry-invite" autoFocus value={inviteCodeDraft} onChange={(event) => setInviteCodeDraft(event.target.value)} placeholder="Paste an invite code" autoComplete="off" disabled={isJoiningServer || !backendOnline} /><button type="submit" disabled={!inviteCodeDraft.trim() || isJoiningServer || !backendOnline}>{isJoiningServer ? 'Joining…' : 'Join server'}</button></div></form><div className="server-entry-divider"><span>OR</span></div><button type="button" className="server-entry-create" onClick={() => { setServerEntryOpen(false); openServerDialog('create') }} disabled={!backendOnline}><Plus size={15} /> Create a server</button>{!backendOnline && <span className="channel-create-offline">Connect to REFORM to join or create a server.</span>}</section></div>}
      {inviteDialogServer && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isLoadingInvite) setInviteDialogServer(null) }}><section className="channel-create-modal server-invite-modal" role="dialog" aria-modal="true" aria-labelledby="server-invite-title"><button type="button" className="profile-modal-close" onClick={() => setInviteDialogServer(null)} aria-label="Close server invite" disabled={isLoadingInvite}>×</button><div className="channel-create-icon"><Users size={20} /></div><h2 id="server-invite-title">Invite people to {inviteDialogServer.name}</h2><p>Share this invitation link with people you want to join your server.</p>{isLoadingInvite ? <p role="status">Creating invite…</p> : <><label className="channel-create-field">Invite code<input readOnly value={serverInviteCode} onFocus={(event) => event.currentTarget.select()} /></label><label className="channel-create-field">Invite link<input readOnly value={`${window.location.origin}/?invite=${encodeURIComponent(serverInviteCode)}`} onFocus={(event) => event.currentTarget.select()} /></label><div className="channel-create-actions"><button type="button" onClick={() => setInviteDialogServer(null)}>Done</button><button type="button" onClick={() => void copyServerInvite()} disabled={!serverInviteCode}>Copy invite link</button></div></>}</section></div>}
      {channelSettingsTarget && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingChannelSettings) setChannelSettingsTarget(null) }}><form className="channel-create-modal" role={confirmChannelDelete ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="text-channel-settings-title" onSubmit={(event) => void saveTextChannelSettings(event)}><button type="button" className="profile-modal-close" onClick={() => setChannelSettingsTarget(null)} aria-label="Close channel settings" disabled={isSavingChannelSettings}>×</button><div className={`channel-create-icon ${confirmChannelDelete ? 'server-delete-icon' : ''}`}>{confirmChannelDelete ? <Trash2 size={20} /> : <Settings size={20} />}</div><h2 id="text-channel-settings-title">{confirmChannelDelete ? `Delete #${channelSettingsTarget.channel.label}?` : 'Text channel settings'}</h2>{confirmChannelDelete ? <p>This permanently removes #{channelSettingsTarget.channel.label} and its chat history for everyone. This cannot be undone.</p> : <><p>Rename or delete the text channel you created.</p><label className="channel-create-field">Channel name<input autoFocus required maxLength={32} value={channelNameDraft} onChange={(event) => setChannelNameDraft(event.target.value)} placeholder="e.g. raid-planning" disabled={isSavingChannelSettings} /></label></>}<div className="channel-create-actions">{confirmChannelDelete ? <><button type="button" onClick={() => setConfirmChannelDelete(false)} disabled={isSavingChannelSettings}>Back</button><button type="button" className="server-delete-confirm" onClick={() => void deleteTextChannel()} disabled={isSavingChannelSettings || !backendOnline}>{isSavingChannelSettings ? 'Deleting…' : <><Trash2 size={14} /> Delete channel</>}</button></> : <><button type="button" onClick={() => setChannelSettingsTarget(null)} disabled={isSavingChannelSettings}>Cancel</button><button type="button" className="channel-delete-action" onClick={() => setConfirmChannelDelete(true)} disabled={isSavingChannelSettings || !backendOnline}>Delete channel</button><button type="submit" disabled={!channelNameDraftIsValid || isSavingChannelSettings || !backendOnline}>{isSavingChannelSettings ? 'Saving…' : 'Save name'}</button></>}</div>{!backendOnline && <span className="channel-create-offline">Connect to the backend to manage text channels.</span>}</form></div>}
      {serverDeleteTarget && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isDeletingServer) setServerDeleteTarget(null) }}><section className="channel-create-modal server-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="server-delete-title" aria-describedby="server-delete-warning"><button type="button" className="profile-modal-close" onClick={() => setServerDeleteTarget(null)} aria-label="Close delete confirmation" disabled={isDeletingServer}>×</button><div className="channel-create-icon server-delete-icon"><Trash2 size={20} /></div><h2 id="server-delete-title">Delete {serverDeleteTarget.name}?</h2><p id="server-delete-warning">This permanently deletes the server, its channels, and all chat history for everyone. This cannot be undone.</p><div className="channel-create-actions"><button type="button" onClick={() => setServerDeleteTarget(null)} disabled={isDeletingServer}>Cancel</button><button type="button" className="server-delete-confirm" onClick={() => void deleteServer()} disabled={isDeletingServer || !backendOnline}>{isDeletingServer ? 'Deleting…' : <> <Trash2 size={14} /> Delete server</>}</button></div>{!backendOnline && <span className="channel-create-offline">Connect to the backend to manage servers.</span>}</section></div>}
      {serverDialogMode && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingServer) setServerDialogMode(null) }}><form className="channel-create-modal" role="dialog" aria-modal="true" aria-labelledby="server-dialog-title" onSubmit={(event) => void saveServer(event)}><button type="button" className="profile-modal-close" onClick={() => setServerDialogMode(null)} aria-label="Close server dialog" disabled={isSavingServer}>×</button><div className="channel-create-icon"><Swords size={20} /></div><h2 id="server-dialog-title">{serverDialogMode === 'create' ? 'Create a server' : 'Rename server'}</h2><p>{serverDialogMode === 'create' ? 'Start a gaming community with its own channels and chat history.' : `Change the name of ${activeServer.name}. Its channels and history will stay intact.`}</p><label className="channel-create-field">Server name<input autoFocus required maxLength={32} title="Use letters, numbers, spaces, hyphens, or underscores. Start with a letter or number." value={serverNameDraft} onChange={(event) => setServerNameDraft(event.target.value)} placeholder="e.g. Raid Squad" disabled={isSavingServer} /></label><div className="channel-create-actions"><button type="button" onClick={() => setServerDialogMode(null)} disabled={isSavingServer}>Cancel</button><button type="submit" disabled={!serverNameIsValid || isSavingServer || !backendOnline}>{isSavingServer ? 'Saving…' : serverDialogMode === 'create' ? 'Create server' : 'Save name'}</button></div>{!backendOnline && <span className="channel-create-offline">Connect to the backend to manage servers.</span>}</form></div>}
      {channelCreationType && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isCreatingChannel) setChannelCreationType(null) }}><form className="channel-create-modal" role="dialog" aria-modal="true" aria-labelledby="channel-create-title" onSubmit={(event) => void createChannel(event)}><button type="button" className="profile-modal-close" onClick={() => setChannelCreationType(null)} aria-label="Close create channel dialog" disabled={isCreatingChannel}>×</button><div className="channel-create-icon">{channelCreationType === 'text' ? <MessageCircle size={20} /> : <Volume2 size={20} />}</div><h2 id="channel-create-title">Create {channelCreationType === 'text' ? 'text channel' : 'voice lounge'}</h2><p>{channelCreationType === 'text' ? 'Give your community a new place to chat.' : 'Create a new room for your community to join.'}</p><label className="channel-create-field">Channel name<input autoFocus required maxLength={32} title="Use letters, numbers, spaces, hyphens, or underscores. Start with a letter or number." value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder={channelCreationType === 'text' ? 'e.g. raid-planning' : 'e.g. Late Night Squad'} disabled={isCreatingChannel} /></label>{channelCreationType === 'text' && <label className="channel-create-field">Channel topic (optional)<input maxLength={120} value={newChannelTopic} onChange={(event) => setNewChannelTopic(event.target.value)} placeholder="What will this channel be about?" disabled={isCreatingChannel} /></label>}<div className="channel-create-actions"><button type="button" onClick={() => setChannelCreationType(null)} disabled={isCreatingChannel}>Cancel</button><button type="submit" disabled={!channelNameIsValid || isCreatingChannel || !backendOnline}>{isCreatingChannel ? 'Creating…' : 'Create channel'}</button></div>{!backendOnline && <span className="channel-create-offline">Connect to the backend to create channels.</span>}</form></div>}
      {viewedProfile && <div className="profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewedProfile(null) }}><section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title"><button className="profile-modal-close" onClick={() => setViewedProfile(null)} aria-label="Close profile">×</button><div className={`profile-modal-avatar ${(viewedProfile === profileName && profilePicture) || viewedMember?.avatarUrl ? 'avatar-picture' : ''}`}>{viewedProfile === profileName && profilePicture ? <img src={profilePicture} alt="" /> : viewedMember?.avatarUrl ? <img src={viewedMember.avatarUrl} alt="" /> : viewedProfile.slice(0, 1).toUpperCase()}</div><span className="profile-modal-status"><i className={viewedProfile === profileName || viewedMember?.online ? 'status-dot' : 'dm-offline-dot'} /> {viewedProfile === profileName ? 'Online' : viewedMember ? viewedMember.online ? 'Online' : 'Offline' : 'Community member'}</span><h2 id="profile-modal-title">{viewedProfile}</h2>{viewedLeaderboardPlayer && viewedLeaderboardRank !== null ? <><p>Rank #{viewedLeaderboardRank} · Level {viewedLeaderboardPlayer.level}</p>{viewedLeaderboardRank <= 3 && <span className={`profile-rank-badge nameplate-${['gold', 'silver', 'bronze'][viewedLeaderboardRank - 1]}`}><Crown size={13} /><span>{['Gold', 'Silver', 'Bronze'][viewedLeaderboardRank - 1]} Crown</span></span>}<div className="profile-modal-stats"><span><strong>{viewedLeaderboardPlayer.level}</strong>Level</span><span><strong>{viewedLeaderboardPlayer.xp.toLocaleString()}</strong>XP</span></div></> : <><p>{viewedProfile === profileName ? `Level ${currentLevel} · REFORM member` : 'REFORM community member'}</p><div className="profile-modal-stats"><span><strong>{viewedProfile === profileName ? currentLevel : '—'}</strong>Level</span><span><strong>{viewedProfile === profileName ? `${progress.xp} XP` : 'Active'}</strong>Progress</span></div></>}{viewedProfile !== profileName && <><div className="profile-modal-actions"><button type="button" className="friend-action-primary" onClick={() => viewedMember ? void changeFriendship(viewedMember, !viewedMemberIsFriend) : setNotice(`${viewedProfile} is not linked to a REFORM account, so friend requests are unavailable.`)} disabled={isLoadingViewedAccount || (viewedMember !== null && (friendActionPending === viewedMember.id || friendActionPending !== null))}>{isLoadingViewedAccount ? 'Loading profile…' : viewedMemberIsFriend ? 'Remove Friend' : 'Add Friend'}</button><button type="button" className="friend-action-secondary" onClick={() => viewedMember ? (setViewedProfile(null), openDirectMessage(viewedMember)) : setNotice(`${viewedProfile} is not linked to a REFORM account, so messaging is unavailable.`)} disabled={isLoadingViewedAccount}><MessageCircle size={15} /> Message</button></div>{!isLoadingViewedAccount && !viewedMember && <p className="profile-action-note">This name is not linked to a registered REFORM account.</p>}</>}</section></div>}
      {voiceJoinNotice && <div className="voice-join-notice" role="status"><span className="join-chime-icon"><Volume2 size={17} /></span><span>{voiceJoinNotice}</span></div>}
      {notice && <div key={noticeSequence} className="toast" role="status">{notice}</div>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate /></StrictMode>)
