# Watch Party

A browser-based watch party. Each participant selects their own copy of the same video; Firebase Realtime Database synchronizes playback controls. The video file is never uploaded.

## Features

- Create a room with a six-character ID.
- Join using an ID or shareable invite URL.
- Any participant can play, pause, seek, and change playback speed.
- Playback state is stored and synchronized through Firebase Realtime Database.
- Presence tracks connected viewers and removes members on disconnect.
- Each participant plays a local file, so there is no video hosting or streaming bandwidth bill.
- React/Vite frontend, deployable to Vercel.

## 1. Create and configure Firebase

1. Create a project at https://console.firebase.google.com/.
2. In **Project settings → General → Your apps**, register a Web app and copy its Firebase config values.
3. In **Build → Realtime Database**, create a database. Copy its database URL exactly (it may end in `firebaseio.com` or `firebasedatabase.app`).
4. In **Build → Authentication → Sign-in method**, enable **Anonymous** authentication.
5. In **Realtime Database → Rules**, use the following rules for this prototype:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

These rules require Firebase Authentication, but any visitor can create an anonymous account and read/write a room if they know its ID. Room IDs are an invitation mechanism, not strong access control. For a public production app, add App Check, rate limiting via a trusted backend, room membership authorization, and stricter validation rules.

## 2. Configure and run locally

Requirements: Node.js 20+ recommended.

```bash
npm install
cp .env.example .env
```

Fill `.env` with the values from your Firebase Web app and Realtime Database:

```env
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_APP_ID=your-app-id
```

Then run:

```bash
npm run dev
```

Open the Vite URL in two browsers/devices to test creating and joining a room.

## 3. Deploy frontend to Vercel

1. Push the project to GitHub.
2. Import the repository at https://vercel.com/new.
3. Select **Vite** as the framework preset.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Add all five `VITE_FIREBASE_*` variables under Vercel project environment variables.
7. Deploy. `vercel.json` rewrites invite URLs such as `https://your-app.vercel.app/?room=ABC123` to the SPA entry point.

Redeploy after changing environment variables.

## How to use

1. Open the app and enter a display name.
2. Click **Create a party**.
3. Copy the invite link or share the six-character room ID.
4. The other viewer joins.
5. Both viewers select the same video file.
6. Use native video controls. Play, pause, seeking, and playback-rate changes synchronize across connected viewers.

## Limitations

- Each viewer needs their own copy of the same video. This app does not transmit the movie.
- Browser codec/container support varies. MP4 with H.264 video and AAC audio is the safest choice; MKV support is inconsistent.
- Browser autoplay policies may block remote playback until the viewer has interacted with the page. If so, press Play once locally.
- Room state is stored in Realtime Database and remains after everyone leaves; this prototype does not expire old rooms automatically.
- Anyone who knows a room ID can join and change playback. Anonymous authentication is enabled, but it does not establish a trusted identity.
- Synchronization is best-effort, not frame-accurate. Network delay, browser scheduling, buffering, and decoding can cause drift.
- Firebase Spark plan quotas and Realtime Database limits apply. Monitor usage in the Firebase console.

## Stack

- React + Vite
- Firebase Authentication (anonymous)
- Firebase Realtime Database (playback state and presence)
- HTML5 `<video>`
- Vercel static hosting
