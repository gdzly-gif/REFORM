# REFORM

REFORM is a Discord-inspired gaming community app with game quest tracking, progression, and animated reactions.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts both the Vite frontend and the Node/Socket.IO backend. Open the local Vite URL shown in the terminal.

## Production deployment

The app can run as a single Node.js service that serves the production-built frontend, API, and Socket.IO from the same origin.

### Railway

1. In the [Railway Dashboard](https://railway.com/new), choose **GitHub Repository** and select `gdzly-gif/REFORM`.
2. Deploy the service. Railway detects the root `Dockerfile`, which builds the app and listens on Railway's injected `PORT`.
3. In the service's **Settings**, configure the healthcheck path as `/api/health`, then generate a public domain under **Networking**.
4. Add a volume under **Volumes** and mount it at `/app/data`. Keep the service to one replica.

The volume preserves accounts, messages, and uploads through restarts and deployments; in-memory sessions and live voice/chat state do not persist, so users sign in again after a restart. Railway Free and Trial volumes are limited to 0.5 GB, while Hobby volumes are 5 GB; storage and compute usage may incur charges depending on the current plan. Check [Railway pricing](https://railway.com/pricing) and set a usage limit before inviting users. The app's local-file storage and in-memory state are intended for a single service instance, not horizontal scaling.

### Render

The repository includes a Render Blueprint at [`render.yaml`](./render.yaml). To deploy it:

1. Push the project to a GitHub repository.
2. In the [Render Dashboard](https://dashboard.render.com), choose **New > Blueprint** and connect that repository.
3. Review the proposed `reform` web service and its 1 GB persistent disk at `/app/data`, then choose **Deploy Blueprint**.
4. Wait for the `/api/health` check to pass and open the generated `onrender.com` URL.

The Blueprint uses the existing Dockerfile, enables HTTPS through Render, supports WebSockets, and trusts the single Render proxy hop. A paid web-service plan is required for the persistent disk. Keep the service to one instance: account and app data are file-backed, while sessions and live voice/chat state are in memory. The app will sign users out after a service restart. Back up the disk before making risky changes.

### Free Render demo

For a no-cost test deployment, use [`render-demo.yaml`](./render-demo.yaml) as a separate Blueprint:

1. In the Render Dashboard, choose **New > Blueprint** and connect the same GitHub repository.
2. Set **Blueprint Path** to `render-demo.yaml` before deploying.
3. Review the `reform-demo` web service and deploy it on the Free plan.

The free demo intentionally has no persistent disk. Free services can spin down after 15 minutes without traffic and may take about a minute to wake. The local-filesystem data used by this app—including accounts, messages, and uploads—can be lost when the service restarts, spins down, or redeploys. Use this only to preview/test the app, not for a public launch or data you need to keep. Render's free-service limits may change; check its current [free instance documentation](https://render.com/docs/free).

### Docker (recommended)

```bash
docker build -t reform .
docker run --name reform \
  -p 3001:3001 \
  -v reform-data:/app/data \
  reform
```

Configure the hosting platform to terminate HTTPS, forward HTTP and WebSocket traffic to port `3001`, and preserve the `/app/data` volume across restarts and redeployments. Set `TRUST_PROXY=1` only when the app is behind exactly one trusted reverse proxy; use the correct hop count for your platform. The image sets `NODE_ENV=production`, binds to `0.0.0.0`, and has a `/api/health` container health check. Do not expose the backend without HTTPS in production.

To build with WebRTC ICE servers, pass `VITE_RTC_ICE_SERVERS` as a Docker build argument. This configuration is included in browser code; use only public STUN endpoints or short-lived TURN credentials, never a long-lived secret.

### Direct Node.js deployment

Use Node.js 22.12 or newer, a persistent writable data directory, and a reverse proxy that supports WebSockets and HTTPS:

```bash
npm ci
npm run build
NODE_ENV=production HOST=0.0.0.0 PORT=3001 npm start
```

Keep `data/` on persistent storage and back it up. Deploy one application instance only: accounts and sessions use JSON files and in-memory sessions, so horizontal scaling, ephemeral filesystems, or uncoordinated replicas can lose data or break authentication and live voice/chat. For multi-instance production, move persistence and sessions to shared transactional services before scaling. Email verification, password recovery, abuse moderation, and server-side cloud sync for XP are not implemented; plan for these before a public launch.

## Accounts and sign-in

- REFORM opens with an email-and-password sign-in screen. New members register with a unique username, email, password, and password confirmation.
- Registration requires a password of at least 12 characters with uppercase and lowercase letters, a number, and a symbol. Passwords are stored as salted scrypt hashes, not plaintext.
- Sign-in uses an HTTP-only, SameSite session cookie (Secure in production). Sessions last up to 30 days and are held in backend memory, so restarting the backend signs users out. Sign-in and registration attempts are rate-limited per client IP.
- Account records are stored in `data/accounts.json`; generated `data/` files are ignored by Git. This local demo does not yet provide email verification, password reset, or production-grade multi-instance session storage.
- Player XP and profile pictures are stored locally per account in the browser; XP is not yet synced across devices.

## Mobile browser support

- The interface adapts to phone and tablet widths with a horizontally scrollable app/server rail, a channel drawer, and a compact chat composer.
- Direct-message conversations include a mobile back action; channel navigation is available from the top-bar menu.
- The layout accounts for mobile safe areas, touch-sized controls, and the on-screen keyboard; community pages and chat remain within the phone viewport without horizontal page scrolling.
- Direct-message voice calls, voice lounges, camera, and screen-share support depends on the browser, microphone permissions, and WebRTC capabilities. Calls require the recipient to be online; screen sharing is not available in every mobile browser.

## Backend

- `GET /api/health` reports backend availability.
- `POST /api/auth/register`, `POST /api/auth/login`, and `POST /api/auth/logout` manage accounts and sessions; `GET /api/auth/me` returns the signed-in account.
- All other `/api` routes and Socket.IO connections require the HTTP-only session cookie. Direct-message identity and profile pictures use the authenticated account ID.
- `GET /api/members/:memberId` and `GET /api/members?name=...` return public profiles for authenticated community members, so profiles opened from chats, voice, or the leaderboard resolve even when the member is offline.
- `GET /api/friends`, `POST /api/friends/:friendId`, and `DELETE /api/friends/:friendId` list, add, and remove friends for the signed-in account. Friend relationships are symmetric and saved in `data/friends.json`; friends remain in the Direct Messages list while offline, and a DM can be started with a friend even when they are offline.
- Online users receive an in-app notification with a short synthesized chime when someone adds them as a friend or sends them a direct message; message alerts are suppressed while that conversation is already open. Incoming messages in the active text channel also play the chime. Browser audio starts after the user's first click or key press.
- `GET /api/servers` returns saved servers and their channel definitions.
- New accounts start with no server memberships. Members can create a server or join through a shareable invitation code/link; only servers the signed-in account belongs to are listed or accessible. Existing accounts are migrated into existing servers to preserve their current access.
- Server creators can rename and delete their servers; deleting a server permanently removes its channels, chat history, and unreferenced chat attachments for everyone. The default REFORM server cannot be deleted. Each server has its own text and voice channels, messages, reactions, and voice rooms.
- Open a server's menu and choose **Invite people** to copy its invitation link. The **+** button in the server rail lets members create a server or join with an invitation code. Text-channel creators can open channel settings from the sidebar or the top bar beside the member button.
- The first backend start migrates the previous global channel configuration in `data/channels.json` and existing message history to the default REFORM server. Server definitions are then stored in `data/servers.json`.
- Text channels and voice lounges can be created from the plus buttons in the sidebar. Text channels created by a member have a settings button for renaming or deleting them; only their creator can manage them, and deleting a channel also removes its chat history. The backend persists channel changes under each server and syncs updates to connected clients.
- `GET /api/servers/:serverId/channels/:channel/messages` returns up to the latest 100 messages for that server and channel.
- Socket.IO persists and broadcasts messages between connected clients in the same server and text channel.
- The app-level Direct Messages tab opens a standalone inbox, separate from server channels, with online members and saved conversations. Direct messages are tied to authenticated account IDs, stored in `data/direct-messages.json`, and delivered live between connected participants. Set a username in Voice & settings to distinguish profiles.
- An online member can be called from an open DM using **Voice call**. Incoming calls ring in the app and can be answered or declined; active calls include mute and hang-up controls. Call invitations and WebRTC signaling are relayed only between the authenticated participants and are not persisted. Voice calls require microphone permission and HTTPS in production; configure `VITE_RTC_ICE_SERVERS` with suitable STUN/TURN servers for peers behind restrictive networks.
- Opening a member profile from chat, voice, or the leaderboard shows Add Friend/Remove Friend and Message actions for account-backed users.
- Each direct conversation has a shared streak: both participants must send at least one message on the same UTC calendar day. The consecutive-day streak is calculated from persisted conversation history.
- Members can add or remove emoji reactions on messages from other users; reaction counts sync live within the text channel and persist with chat history.
- Server chat messages show a player nameplate in every text channel and voice-lounge chat. Members connected to a voice lounge get a gold crown nameplate with a shine effect in chat, the voice roster, and the voice stage.
- Chat supports up to four files per message, with a 5 MB per-file limit. Raster images are previewed in chat; other file types are offered as downloads. Uploaded files and attachment messages are stored by the backend.
- The profile-picture setting syncs PNG, JPEG, GIF, and WebP avatars to the backend, storing images under `data/profile-pictures/`. New chat messages display the sender's profile picture to other members and retain that avatar reference in chat history; users without a picture keep their initial avatar.
- Text channels start without seeded chat history; messages appear as members begin chatting. New member greetings are posted to the dedicated `#welcome` channel; its dashboard remains separate from regular chat channels.
- Voice channel presence is shared between connected clients, with microphone mute and audio deafen controls.
- Each voice lounge has a chat button beside its live member count. Lounge chat is a separate, persistent conversation that works while listening or speaking in voice, and is shared with everyone in that server.
- Selecting a voice lounge opens a full voice stage in the main app area. Every participant appears as a tile; live camera and screen-share streams are shown there, and selecting a participant pins their tile in front. The stage includes camera, screen-share, microphone, deafen, minimize, and leave controls and adapts to mobile layouts. Minimizing the stage or navigating to another tab keeps voice connected and shows the active video in a floating picture-in-picture window; video previews do not appear in the sidebar.
- On mobile, minimizing the voice stage or opening another tab shows a compact floating voice overlay with connection status, camera/screen preview when available, microphone and deafen controls, lounge chat, and leave/reopen actions. Joining a lounge requests browser notification permission; if granted, a system notification appears when someone joins while the app is in the background.
- The bottom-left voice/settings menu offers microphone and output-device selection, microphone and playback volume sliders, camera preview, and screen sharing while connected to voice.
- Voice settings open as an animated popover from the hamburger; it includes a locally stored profile-picture picker that syncs for chat display and a live signal indicator based on WebRTC round-trip time.
- Camera and screen-share video are sent to other members over the existing WebRTC voice connection, with renegotiation as tracks change. Screen capture requires a browser that supports `getDisplayMedia` and a secure context (localhost or HTTPS); if capture is unavailable, the app reports that directly. Camera and device options require browser permissions; output-device selection depends on browser `setSinkId` support.
- Joining a voice room plays a short synthesized chime and shows a temporary join notification to current room members.
- Speaking members get an animated green avatar ring based on measured microphone audio; speaking state is relayed to members in the same room.
- Voice audio uses browser WebRTC peer connections. It works best on the same LAN by default; configure `VITE_RTC_ICE_SERVERS` with your own STUN/TURN server JSON for reliable internet connections.
- Chat messages are stored in `data/messages.json`.

## Leaderboard and quests

- Daily and weekly quests track daily sign-in, messages sent, message reactions, and voice-channel participation. Signing in marks the daily check-in complete; completed quests can be claimed for XP. Every 500 XP advances a player's level, starting at Level 0.
- Progress is stored in the current browser's local storage and is not shared between accounts or devices.
- The leaderboard starts empty and shows the signed-in player's local ranking after they earn XP. Progress and rankings are currently local to each browser and are not a server-wide leaderboard.

The welcome dashboard starts with no tracked games or recent activity. Microphone permission is requested when joining a voice channel. A TURN service may be required for voice connections across restrictive networks.

For remote voice connections, add your own ICE server configuration to an untracked `.env.local` file, for example:

```env
VITE_RTC_ICE_SERVERS=[{"urls":"stun:your-stun-server:3478"},{"urls":"turn:your-turn-server:3478","username":"your-username","credential":"your-credential"}]
```

Restart the dev server after changing ICE settings. Do not commit real TURN credentials.
