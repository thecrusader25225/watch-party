import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Copy,
  LogOut,
  Play,
  Pause,
  Users,
  Upload,
  Wifi,
  Check,
  AlertCircle,
  Film,
  Cloud,
} from "lucide-react";

import { isFirebaseConfigured, auth, db } from "./firebase";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import {
  onValue,
  onDisconnect,
  ref,
  remove,
  set,
} from "firebase/database";

const WORKER_URL = (import.meta.env.VITE_WORKER_URL || "").replace(/\/$/, "");
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;

const makeRoomId = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
};

const makeClientId = () => crypto.randomUUID().replaceAll("-", "");
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function App() {
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("wp-name") || "");

  const [joined, setJoined] = useState(false);
  const [connection, setConnection] = useState("disconnected");
  const [members, setMembers] = useState(0);
  const [role, setRole] = useState("");

  const [videoUrl, setVideoUrl] = useState("");
  const [remoteMedia, setRemoteMedia] = useState(null);
  const [library, setLibrary] = useState([]);
  const [activeMediaId, setActiveMediaId] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);

  const [firebaseUser, setFirebaseUser] = useState(null);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const clientIdRef = useRef(makeClientId());

  const joinedRef = useRef(false);
  const currentRoomRef = useRef("");
  const memberRefRef = useRef(null);
  const unsubscribersRef = useRef([]);

  const lastAppliedRef = useRef(0);
  const applyingRemoteRef = useRef(false);
  // On every room join, apply the room's persisted playback state even if
  // this browser originally wrote it (same clientId after leaving/rejoining).
  const forcePlaybackHydrationRef = useRef(false);
  const latestStateRef = useRef(null);
  const pendingTimerRef = useRef(null);

  const mediaKeyRef = useRef(null);
  const playbackRequestRef = useRef(null);
  const activeMediaIdRef = useRef(null);
  const libraryItemsRef = useRef([]);

  useEffect(() => {
    localStorage.setItem("wp-name", name);
  }, [name]);

  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;
    return onAuthStateChanged(auth, (user) => setFirebaseUser(user));
  }, []);

  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get("room");
    if (invite) setRoomInput(invite.toUpperCase());
  }, []);

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      unsubscribersRef.current.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const stopRoomListeners = useCallback(() => {
    unsubscribersRef.current.forEach((unsubscribe) => unsubscribe());
    unsubscribersRef.current = [];
  }, []);

  const publishState = useCallback(
    async (statusOverride) => {
      if (!joinedRef.current || !roomId || applyingRemoteRef.current) return;

      const video = videoRef.current;
      const status =
        statusOverride || (video && !video.paused ? "playing" : "paused");

      const state = {
        status,
        position:
          video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
        playbackRate: video?.playbackRate || 1,
        updatedAt: Date.now(),
        startAt: status === "playing" ? Date.now() + 700 : null,
        revision: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        sender: clientIdRef.current,
      };

      latestStateRef.current = state;

      try {
        await set(ref(db, `rooms/${roomId}/playback`), state);
      } catch (error) {
        console.error("Firebase playback write failed:", error);
        setNotice("Couldn't send a sync update. Check your connection and Firebase rules.");
      }
    },
    [roomId]
  );

  const applyState = useCallback(async (state, force = false) => {
    if (!state) return;

    latestStateRef.current = state;
    const video = videoRef.current;
    if (!video) return;

    const shouldForce = force || forcePlaybackHydrationRef.current;
    if (state.sender === clientIdRef.current && !shouldForce) return;

    const revision = Number(state.revision || 0);
    if (revision && revision <= lastAppliedRef.current) return;
    lastAppliedRef.current = revision;

    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);

    let target = Number(state.position || 0);
    if (state.status === "playing") {
      const referenceTime = Number(state.startAt || state.updatedAt || Date.now());
      target +=
        (Math.max(0, Date.now() - referenceTime) / 1000) *
        Number(state.playbackRate || 1);
    }

    if (Number.isFinite(video.duration)) {
      target = clamp(target, 0, Math.max(0, video.duration - 0.1));
    }

    // The saved state has now been applied for this join. Subsequent echoes
    // from this same client should not fight local playback controls.
    forcePlaybackHydrationRef.current = false;
    applyingRemoteRef.current = true;

    try {
      if (Math.abs(video.currentTime - target) > 0.18) {
        video.currentTime = target;
      }
      video.playbackRate = Number(state.playbackRate || 1);

      if (state.status === "playing") {
        const delay = state.startAt
          ? Math.max(0, Number(state.startAt) - Date.now())
          : 0;

        pendingTimerRef.current = setTimeout(async () => {
          try {
            await video.play();
            setPlaying(true);
          } catch {
            setNotice(
              "Your browser blocked remote playback. Press Play once to enable synchronized playback."
            );
          } finally {
            applyingRemoteRef.current = false;
          }
        }, delay);
      } else {
        video.pause();
        setPlaying(false);
        applyingRemoteRef.current = false;
      }
    } catch (error) {
      applyingRemoteRef.current = false;
      console.error("Couldn't apply playback state:", error);
    }
  }, []);

  const loadRemoteVideo = useCallback(async (media, user, targetRoom) => {
    if (!media?.key || !user || !targetRoom || !WORKER_URL) return;

    const requestId = `${targetRoom}:${media.key}`;
    if (
      playbackRequestRef.current === requestId &&
      mediaKeyRef.current === media.key
    ) {
      return;
    }

    playbackRequestRef.current = requestId;

    try {
      const token = await user.getIdToken();
      const response = await fetch(`${WORKER_URL}/playback-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ roomId: targetRoom, key: media.key }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not retrieve playback URL");
      }

      // Ignore a response that arrives after the user has left or changed rooms.
      if (currentRoomRef.current !== targetRoom) return;
      if (playbackRequestRef.current !== requestId) return;

      mediaKeyRef.current = media.key;
      setRemoteMedia(media);
      setVideoUrl(result.playbackUrl);
      setNotice("");
    } catch (error) {
      if (playbackRequestRef.current === requestId) {
        playbackRequestRef.current = null;
      }
      console.error("Playback URL request failed:", error);
      if (currentRoomRef.current === targetRoom) {
        setNotice(`Couldn't load video: ${error.message}`);
      }
    }
  }, []);

  const fetchRoomLibrary = useCallback(async (targetRoom, user) => {
    if (!targetRoom || !user || !WORKER_URL) return [];

    const token = await user.getIdToken();
    const response = await fetch(`${WORKER_URL}/list-videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ roomId: targetRoom }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `Library request failed: HTTP ${response.status}`);
    }

    const items = (result.videos || []).map((video) => ({
      ...video,
      id: video.key,
    }));

    libraryItemsRef.current = items;
    setLibrary(items);
    return items;
  }, []);

  const selectLibraryVideo = useCallback(
    async (item) => {
      if (!joinedRef.current || !roomId || !item?.id || uploading) return;
      try {
        await set(ref(db, `rooms/${roomId}/activeMedia`), {
        mediaId: item.key,
        changedAt: Date.now(),
        changedBy: firebaseUser?.uid || null,
      });
      await set(ref(db, `rooms/${roomId}/playback`), {
        status: "paused",
        position: 0,
        playbackRate: 1,
        updatedAt: Date.now(),
        startAt: null,
        revision: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        sender: clientIdRef.current,
      });
      } catch (error) {
        setNotice(`Couldn't select video: ${error.message}`);
      }
    },
    [roomId, uploading, firebaseUser]
  );

  const uploadVideo = async (selected) => {
    if (!selected || !roomId || !firebaseUser) return;

    if (role !== "host") {
      setNotice("Only the host can upload a video.");
      return;
    }
    if (!selected.type.startsWith("video/")) {
      setNotice("Please choose a video file.");
      return;
    }
    if (selected.size > MAX_UPLOAD_SIZE) {
      setNotice("Video exceeds the 5 GB single-upload limit.");
      return;
    }
    if (!WORKER_URL) {
      setNotice("VITE_WORKER_URL is missing from your frontend .env.");
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setNotice("Preparing upload...");

    try {
      const token = await firebaseUser.getIdToken();
      const contentType = selected.type || "video/mp4";

      const response = await fetch(`${WORKER_URL}/upload-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          roomId,
          filename: selected.name,
          contentType,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not create upload URL");
      }

      setNotice("Uploading video to Cloudflare R2...");
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", result.uploadUrl);
        xhr.setRequestHeader("Content-Type", contentType);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`R2 upload failed: HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("Network error while uploading to R2"));
        xhr.onabort = () => reject(new Error("Upload was cancelled"));
        xhr.send(selected);
      });

      if (currentRoomRef.current !== roomId) {
        throw new Error("You left the room before the upload completed.");
      }

      setNotice("Upload complete. Refreshing the room library from R2...");
      const items = await fetchRoomLibrary(roomId, firebaseUser);
      const uploadedItem = items.find((item) => item.key === result.key) || {
        id: result.key,
        key: result.key,
        name: selected.name,
        size: selected.size,
        uploadedAt: Date.now(),
      };

      await set(ref(db, `rooms/${roomId}/activeMedia`), {
        mediaId: uploadedItem.key,
        changedAt: Date.now(),
        changedBy: firebaseUser.uid,
      });
      await set(ref(db, `rooms/${roomId}/playback`), {
        status: "paused",
        position: 0,
        playbackRate: 1,
        updatedAt: Date.now(),
        startAt: null,
        revision: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        sender: clientIdRef.current,
      });

      setNotice("Video uploaded and added to the room library.");
    } catch (error) {
      console.error("Video upload failed:", error);
      setNotice(`Upload failed: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const joinRoom = async (id, requestedRole = "guest") => {
    if (!isFirebaseConfigured) {
      setNotice("Add your Firebase web app configuration to .env first.");
      return;
    }
    if (!WORKER_URL) {
      setNotice("Configure VITE_WORKER_URL in your frontend .env.");
      return;
    }
    if (!name.trim()) {
      setNotice("Enter a display name first.");
      return;
    }

    const normalized = id.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      setNotice("Room IDs must be six letters or numbers.");
      return;
    }

    if (joinedRef.current) await leaveRoom();

    setNotice("");
    setConnection("connecting");

    try {
      const credential = firebaseUser || (await signInAnonymously(auth)).user;
      setFirebaseUser(credential);

      const memberRef = ref(
        db,
        `rooms/${normalized}/members/${clientIdRef.current}`
      );
      memberRefRef.current = memberRef;
      await onDisconnect(memberRef).remove();
      await set(memberRef, {
        uid: credential.uid,
        name: name.trim(),
        role: requestedRole,
        joinedAt: Date.now(),
      });

      currentRoomRef.current = normalized;
      // Hydrate the player from the room's existing playback record. Do not
      // initialize playback to zero when someone reconnects.
      forcePlaybackHydrationRef.current = true;
      latestStateRef.current = null;
      lastAppliedRef.current = 0;
      mediaKeyRef.current = null;
      playbackRequestRef.current = null;
      libraryItemsRef.current = [];
      setLibrary([]);
      joinedRef.current = true;
      setRoomId(normalized);
      setRole(requestedRole);

      const stopState = onValue(
        ref(db, `rooms/${normalized}/playback`),
        (snapshot) => {
          const value = snapshot.val();
          if (value) applyState(value);
        },
        (error) => setNotice(`Playback listener: ${error.message}`)
      );

      const stopMembers = onValue(
        ref(db, `rooms/${normalized}/members`),
        (snapshot) => {
          setMembers(snapshot.exists() ? Object.keys(snapshot.val()).length : 0);
        },
        (error) => setNotice(`Presence listener: ${error.message}`)
      );

      // R2 is the source of truth for the room's uploaded video library.
      try {
        await fetchRoomLibrary(normalized, credential);
      } catch (error) {
        console.error("R2 library request failed:", error);
        setNotice(`Couldn't load room library: ${error.message}`);
      }

      const stopActiveMedia = onValue(
        ref(db, `rooms/${normalized}/activeMedia`),
        async (snapshot) => {
          const selection = snapshot.val();
          if (!selection?.mediaId) {
            activeMediaIdRef.current = null;
            setActiveMediaId(null);
            return;
          }

          // activeMedia.mediaId stores the R2 object key, not a Firebase push ID.
          const selectedKey = selection.mediaId;
          activeMediaIdRef.current = selectedKey;
          setActiveMediaId(selectedKey);

          try {
            let media = libraryItemsRef.current.find(
              (item) => item.key === selectedKey
            );

            if (!media) {
              const refreshed = await fetchRoomLibrary(normalized, credential);
              media = refreshed.find((item) => item.key === selectedKey);
            }

            if (!media) {
              throw new Error("Selected video was not found in this room's R2 library");
            }
            if (currentRoomRef.current !== normalized) return;
            if (mediaKeyRef.current === media.key) return;

            latestStateRef.current = null;
            lastAppliedRef.current = 0;
            playbackRequestRef.current = null;
            setPlaying(false);
            await loadRemoteVideo(media, credential, normalized);
          } catch (error) {
            console.error("Could not load selected R2 video:", error);
            setNotice(`Couldn't load selected video: ${error.message}`);
          }
        },
        (error) => setNotice(`Active video listener: ${error.message}`)
      );

      unsubscribersRef.current = [
        stopState,
        stopMembers,
        stopActiveMedia,
      ];

      setJoined(true);
      setConnection("connected");
    } catch (error) {
      console.error("Firebase join failed:", error);
      joinedRef.current = false;
      currentRoomRef.current = "";
      setConnection("disconnected");
      setNotice(`Couldn't join the room: ${error.message}`);
      if (memberRefRef.current) {
        try {
          await remove(memberRefRef.current);
        } catch {
          // Presence cleanup is best-effort if joining failed partway through.
        }
        memberRefRef.current = null;
      }
      stopRoomListeners();
    }
  };

  const createParty = () => joinRoom(makeRoomId(), "host");

  const leaveRoom = async () => {
    joinedRef.current = false;
    currentRoomRef.current = "";
    stopRoomListeners();

    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }

    if (memberRefRef.current) {
      try {
        await remove(memberRefRef.current);
      } catch (error) {
        console.warn("Presence cleanup failed:", error);
      }
      memberRefRef.current = null;
    }

    playbackRequestRef.current = null;
    mediaKeyRef.current = null;
    activeMediaIdRef.current = null;
    libraryItemsRef.current = [];
    latestStateRef.current = null;
    lastAppliedRef.current = 0;
    forcePlaybackHydrationRef.current = false;

    setJoined(false);
    setConnection("disconnected");
    setMembers(0);
    setRoomId("");
    setRole("");
    setPlaying(false);
    setRemoteMedia(null);
    setVideoUrl("");
    setLibrary([]);
    setActiveMediaId(null);
    setUploadProgress(0);
  };

  const onPlay = () => {
    setPlaying(true);
    if (!applyingRemoteRef.current) publishState("playing");
  };

  const onPause = () => {
    setPlaying(false);
    if (
      !applyingRemoteRef.current &&
      videoRef.current &&
      !videoRef.current.ended
    ) {
      publishState("paused");
    }
  };

  const onSeeked = () => {
    if (!applyingRemoteRef.current) publishState();
  };

  const onRateChange = () => {
    if (!applyingRemoteRef.current) publishState();
  };

  const copyInvite = async () => {
    const url = `${window.location.origin}/?room=${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice(`Share this link: ${url}`);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Watch Party home">
          <span className="brand-icon"><Clapperboard size={20} /></span>
          <span>watch<span className="brand-accent">party</span></span>
        </a>
        <div className="top-status">
          <span className={`status-dot ${connection === "connected" ? "online" : ""}`} />
          {joined ? connection : "Not in a party"}
        </div>
      </header>

      {!joined ? (
        <section className="landing">
          <div className="hero-mark"><Film size={30} /></div>
          <p className="eyebrow">WATCH TOGETHER, FROM ANYWHERE</p>
          <h1>Same movie.<br /><span>Same moment.</span></h1>
          <p className="hero-copy">
            Create a private room, share the code, and watch in sync.
            The host uploads once, everyone streams from the cloud.
          </p>

          <div className="join-card">
            <label htmlFor="display-name">YOUR NAME</label>
            <input
              id="display-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Enter a display name"
              maxLength={24}
              autoComplete="nickname"
            />

            <button
              className="primary-button"
              onClick={createParty}
              disabled={!name.trim() || connection === "connecting"}
            >
              <Clapperboard size={17} /> Create a party
            </button>

            <div className="or-divider"><span>OR JOIN AN EXISTING PARTY</span></div>

            <div className="join-row">
              <input
                aria-label="Party ID"
                value={roomInput}
                onChange={(event) =>
                  setRoomInput(
                    event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
                  )
                }
                placeholder="ENTER PARTY ID"
                maxLength={6}
              />
              <button
                className="secondary-button"
                onClick={() => joinRoom(roomInput)}
                disabled={roomInput.length !== 6 || connection === "connecting"}
              >
                Join
              </button>
            </div>
          </div>

          {!isFirebaseConfigured && (
            <div className="notice warning">
              <AlertCircle size={16} /> Firebase isn't configured. Check your frontend .env.
            </div>
          )}
          {notice && <div className="notice"><AlertCircle size={16} />{notice}</div>}

          <div className="feature-row">
            <span><Wifi size={15} /> Real-time sync</span>
            <span><Users size={15} /> Invite by code</span>
            <span><Cloud size={15} /> Cloud video</span>
          </div>
        </section>
      ) : (
        <section className="party-view">
          <div className="party-heading">
            <div>
              <p className="eyebrow">YOU'RE IN A WATCH PARTY</p>
              <h2>Room <span>{roomId}</span></h2>
            </div>
            <div className="party-actions">
              <button className="secondary-button invite-button" onClick={copyInvite}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "Copied" : "Copy invite"}
              </button>
              <button className="icon-button" onClick={leaveRoom} title="Leave party">
                <LogOut size={17} />
              </button>
            </div>
          </div>

          <div className="party-meta">
            <span>
              <span className={`status-dot ${connection === "connected" ? "online" : ""}`} />
              {connection === "connected" ? "Live connection" : connection}
            </span>
            <span><Users size={15} /> {members} {members === 1 ? "viewer" : "viewers"}</span>
            <span>{role === "host" ? "Host" : "Guest"}</span>
          </div>

          <div className="player-card">
            {videoUrl ? (
              <video
                ref={videoRef}
                key={remoteMedia?.key || videoUrl}
                src={videoUrl}
                controls
                playsInline
                onLoadedMetadata={() => {
                  if (latestStateRef.current) {
                    applyState(latestStateRef.current, true);
                  } else {
                    publishState("paused");
                  }
                }}
                onPlay={onPlay}
                onPause={onPause}
                onSeeked={onSeeked}
                onRateChange={onRateChange}
                onEnded={() => publishState("paused")}
              />
            ) : (
              <div className="empty-player">
                <div className="upload-icon">
                  {role === "host" ? <Upload size={25} /> : <Cloud size={25} />}
                </div>
                {role === "host" ? (
                  <>
                    <h3>Upload your movie</h3>
                    <p>
                      Choose a video to upload to Cloudflare R2.
                      Everyone in this room will be able to stream it.
                    </p>
                    <button
                      className="primary-button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      <Upload size={17} /> {uploading ? "Uploading..." : "Select video"}
                    </button>
                  </>
                ) : (
                  <>
                    <h3>Choose a video from the room library</h3>
                    <p>The selected video will appear here automatically.</p>
                    <Cloud size={20} />
                  </>
                )}
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mkv,.avi,.mov,.mp4,.webm"
            hidden
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) uploadVideo(selected);
              event.target.value = "";
            }}
          />

          <div className="library-section">
            <div className="library-heading">
              <div>
                <h3>Room library</h3>
                <p>{library.length} uploaded {library.length === 1 ? "video" : "videos"}</p>
              </div>
              {role === "host" && (
                <button
                  className="secondary-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Upload size={16} /> Upload
                </button>
              )}
            </div>

            {library.length === 0 ? (
              <div className="library-empty">
                <Cloud size={25} />
                <p>No videos uploaded yet.</p>
                {role === "guest" && <small>The host can add videos to this room.</small>}
              </div>
            ) : (
              <div className="library-list">
                {library.map((item) => (
                  <button
                    key={item.id}
                    className={`library-item ${activeMediaId === item.id ? "active" : ""}`}
                    onClick={() => selectLibraryVideo(item)}
                    disabled={uploading}
                    title={`Play ${item.name}`}
                  >
                    <Film size={21} />
                    <div className="library-item-info">
                      <strong>{item.name}</strong>
                      <small>
                        {(Number(item.size || 0) / (1024 * 1024)).toFixed(1)} MB
                      </small>
                    </div>
                    {activeMediaId === item.id ? <span>Selected</span> : <Play size={17} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {uploading && (
            <div className="upload-progress">
              <div className="upload-progress-label">
                <span>Uploading to Cloudflare R2</span>
                <span>{uploadProgress}%</span>
              </div>
              <progress value={uploadProgress} max="100" />
            </div>
          )}

          {videoUrl && remoteMedia && (
            <div className="file-bar">
              <div className="file-info">
                <Film size={17} />
                <div>
                  <strong>{remoteMedia.name}</strong>
                  <small>
                    {(Number(remoteMedia.size || 0) / (1024 * 1024)).toFixed(1)} MB
                    {" · Cloudflare R2"}
                  </small>
                </div>
              </div>
              {role === "host" && (
                <button
                  className="text-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  Add another video
                </button>
              )}
            </div>
          )}

          {notice && <div className="notice"><AlertCircle size={16} />{notice}</div>}

          <div className="sync-info">
            <div className="sync-icon"><Wifi size={17} /></div>
            <div>
              <strong>Playback is shared with everyone</strong>
              <p>
                Play, pause, seek and playback speed changes are synchronized
                for all connected viewers.
              </p>
            </div>
          </div>

          <div className="party-footer">
            <span>Video hosted securely on Cloudflare R2.</span>
            <span>
              {playing ? <><Play size={12} fill="currentColor" /> Playing</> : <><Pause size={12} /> Paused</>}
            </span>
          </div>
        </section>
      )}

      <footer>
        Made for movie nights <span>·</span> Watch together, anywhere
      </footer>
    </main>
  );
}

export default App;
