import React, { useCallback, useEffect, useRef, useState } from "react";

import {

  BrowserRouter,

  Routes,

  Route,

  Navigate,

  useNavigate,

  useParams,

} from "react-router-dom";

import {


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

  MessageCircle,

  Send,

  PanelLeftClose,

  PanelLeftOpen,

  PanelRightClose,

  PanelRightOpen,

  Plus,

  ArrowRight,

  Library,

  Pencil,

  Trash2,

} from "lucide-react";

import { isFirebaseConfigured, auth, db } from "./firebase";

import { onAuthStateChanged, signInAnonymously } from "firebase/auth";

import {

  onValue,

  onDisconnect,

  ref,

  remove,

  set,

  push,

  query,

  limitToLast,

  get,

  runTransaction,

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

const formatBytes = (bytes) =>

  `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;

// Firebase Realtime Database keys cannot contain ., #, $, [, ], or /.
const getMetadataKey = (key) =>
  encodeURIComponent(String(key || "")).replaceAll(".", "%2E");

// Supports metadata written by earlier versions of the app.
const getLegacyMetadataKey = (key) => String(key || "").replaceAll("/", "__");

function App() {

  return (

    <BrowserRouter>

      <Routes>

        <Route path="/" element={<WatchParty />} />

        <Route path="/room/:roomId" element={<WatchParty />} />

        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>

    </BrowserRouter>

  );

}

function WatchParty() {

  const navigate = useNavigate();

  const { roomId: routeRoomId } = useParams();

  const [roomInput, setRoomInput] = useState("");

  const [name, setName] = useState(() => localStorage.getItem("wp-name") || "");

  const [authReady, setAuthReady] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");

  const [firebaseUser, setFirebaseUser] = useState(null);

  const [joined, setJoined] = useState(false);

  const [connection, setConnection] = useState("disconnected");

  const [roomId, setRoomId] = useState("");

  const [roomName, setRoomName] = useState("");

  const [role, setRole] = useState("");

  const [memberList, setMemberList] = useState([]);

  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(true);

  const [messages, setMessages] = useState([]);

  const [chatInput, setChatInput] = useState("");
  const [unreadChat, setUnreadChat] = useState(false);

  const [videoUrl, setVideoUrl] = useState("");

  const [remoteMedia, setRemoteMedia] = useState(null);

  const [library, setLibrary] = useState([]);

  const [activeMediaId, setActiveMediaId] = useState(null);

  const [uploading, setUploading] = useState(false);

  const [uploadProgress, setUploadProgress] = useState(0);

  const [notice, setNotice] = useState("");

  const [copied, setCopied] = useState(false);

  const [playing, setPlaying] = useState(false);

  // 100% is the normal volume; Web Audio gain permits amplification up to 200%.
  const [volumePercent, setVolumePercent] = useState(100);

  const [leftCollapsed, setLeftCollapsed] = useState(false);

  const [rightCollapsed, setRightCollapsed] = useState(false);

  const videoRef = useRef(null);

  const audioContextRef = useRef(null);
  const audioGainRef = useRef(null);
  const audioSourceRef = useRef(null);

  const fileInputRef = useRef(null);

  const chatEndRef = useRef(null);

  const clientIdRef = useRef(makeClientId());

  const joinedRef = useRef(false);

  const currentRoomRef = useRef("");

  const memberRefRef = useRef(null);

  const unsubscribersRef = useRef([]);

  const lastAppliedRef = useRef(0);

  const applyingRemoteRef = useRef(false);

  const forcePlaybackHydrationRef = useRef(false);

  const latestStateRef = useRef(null);

  const pendingTimerRef = useRef(null);

  const mediaKeyRef = useRef(null);

  const playbackRequestRef = useRef(null);

  const libraryItemsRef = useRef([]);

  const roomJoinInProgressRef = useRef(false);
  const loadingCountRef = useRef(0);
  const lastObservedMessageIdRef = useRef(null);
  const unreadSidebarRef = useRef(leftCollapsed);
  // Firebase's serverTimeOffset keeps playback timestamps comparable across devices.
  const serverTimeOffsetRef = useRef(0);
  const getServerNow = () => Date.now() + serverTimeOffsetRef.current;

  const beginLoading = useCallback((label) => {
    loadingCountRef.current += 1;
    setLoadingMessage(label);
  }, []);
  const endLoading = useCallback(() => {
    loadingCountRef.current = Math.max(0, loadingCountRef.current - 1);
    if (loadingCountRef.current === 0) setLoadingMessage("");
  }, []);

  useEffect(() => {

    localStorage.setItem("wp-name", name);

  }, [name]);

  useEffect(() => {
    unreadSidebarRef.current = leftCollapsed;
    if (!leftCollapsed) {
      setUnreadChat(false);
      if (messages.length) {
        lastObservedMessageIdRef.current = messages[messages.length - 1].id;
      }
    }
  }, [leftCollapsed, messages]);

  useEffect(() => {
    if (!joined || !messages.length) return;
    const latest = messages[messages.length - 1];
    const previousId = lastObservedMessageIdRef.current;
    if (previousId === null) {
      lastObservedMessageIdRef.current = latest.id;
      return;
    }
    if (latest.id !== previousId) {
      const previousIndex = messages.findIndex((message) => message.id === previousId);
      const newMessages = previousIndex >= 0 ? messages.slice(previousIndex + 1) : [latest];
      if (unreadSidebarRef.current && newMessages.some((message) => message.uid !== firebaseUser?.uid)) {
        setUnreadChat(true);
      }
      lastObservedMessageIdRef.current = latest.id;
    }
  }, [messages, joined, firebaseUser]);

  // Firebase provides an estimated offset between this device's clock and
  // the database server clock. Both clients use that shared time reference.
  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;

    const stop = onValue(
      ref(db, ".info/serverTimeOffset"),
      (snapshot) => {
        serverTimeOffsetRef.current = Number(snapshot.val() || 0);
      },
    );

    return stop;
  }, []);

  useEffect(() => {

    if (!isFirebaseConfigured) {

      setAuthReady(true);

      return undefined;

    }

    return onAuthStateChanged(auth, (user) => {

      setFirebaseUser(user);

      setAuthReady(true);

    });

  }, []);

  useEffect(() => {

    if (!isFirebaseConfigured || !authReady || !firebaseUser) return undefined;

    setRoomsLoading(true);
    const stop = onValue(

      ref(db, "roomRegistry"),

      (snapshot) => {

        const value = snapshot.val() || {};

        const all = Object.entries(value).map(([id, data]) => ({

          id,

          ...data,

        }));

        all.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

        setRooms(all);
        setRoomsLoading(false);

      },

      (error) => {
        console.error("Room registry listener:", error);
        setRoomsLoading(false);
      },

    );

    return stop;

  }, [authReady, firebaseUser]);

  useEffect(() => {

    return () => {

      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);

      unsubscribersRef.current.forEach((stop) => stop());

    };

  }, []);

  useEffect(() => {

    if (

      authReady &&

      routeRoomId &&

      !joinedRef.current &&

      !roomJoinInProgressRef.current

    ) {

      if (!name.trim()) {

        setRoomInput(routeRoomId.toUpperCase());

        return;

      }

      joinRoom(routeRoomId, "guest");

    }

    if (!routeRoomId && joinedRef.current) leaveRoom(false);

    // Route changes intentionally trigger room restoration.

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [authReady, routeRoomId, name]);

  useEffect(() => {

    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });

  }, [messages]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return undefined;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setNotice("Audio amplification is not supported by this browser.");
      return undefined;
    }

    let context;
    try {
      context = new AudioContextClass();
      const source = context.createMediaElementSource(video);
      const gain = context.createGain();
      gain.gain.value = volumePercent / 100;
      source.connect(gain);
      gain.connect(context.destination);
      audioContextRef.current = context;
      audioSourceRef.current = source;
      audioGainRef.current = gain;
    } catch (error) {
      console.error("Audio amplification setup failed:", error);
      setNotice("Couldn't enable volume amplification in this browser.");
      if (context && context.state !== "closed") context.close().catch(() => {});
      return undefined;
    }

    return () => {
      audioGainRef.current = null;
      audioSourceRef.current = null;
      audioContextRef.current = null;
      if (context && context.state !== "closed") context.close().catch(() => {});
    };
    // Recreate the media audio graph when a different video element is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, remoteMedia?.key]);

  useEffect(() => {
    if (audioGainRef.current) {
      audioGainRef.current.gain.setTargetAtTime(
        volumePercent / 100,
        audioGainRef.current.context.currentTime,
        0.015,
      );
    }
  }, [volumePercent]);

  const stopRoomListeners = useCallback(() => {

    unsubscribersRef.current.forEach((stop) => stop());

    unsubscribersRef.current = [];

  }, []);

  const publishState = useCallback(async (statusOverride) => {

    if (

      !joinedRef.current ||

      !currentRoomRef.current ||

      applyingRemoteRef.current

    )

      return;

    const video = videoRef.current;

    const status =

      statusOverride || (video && !video.paused ? "playing" : "paused");

    const now = getServerNow();

    const position =
      video && Number.isFinite(video.currentTime) ? video.currentTime :
      Number(latestStateRef.current?.position || 0);
    const state = {
      status,
      position,
      playbackRate: video?.playbackRate || latestStateRef.current?.playbackRate || 1,
      updatedAt: now,
      startAt: status === "playing" ? now : null,
      lastPausedAt: status === "paused" ? now : latestStateRef.current?.lastPausedAt || null,
      lastPausedPosition: status === "paused" ? position : latestStateRef.current?.lastPausedPosition ?? null,
      revision: now * 1000 + Math.floor(Math.random() * 1000),
      sender: clientIdRef.current,
    };

    latestStateRef.current = state;

    try {

      await set(ref(db, `rooms/${currentRoomRef.current}/playback`), state);

    } catch (error) {

      console.error("Playback write failed:", error);

      setNotice(

        "Couldn't send a sync update. Check your connection and Firebase rules.",

      );

    }

  }, []);

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

    const playbackRate = Number(state.playbackRate || 1);
    const serverNow = getServerNow();
    const playbackStart = Number(
      state.startAt || state.updatedAt || serverNow,
    );

    if (state.status === "playing") {
      // position is the position at playbackStart, not updatedAt.
      // Never use the receiver's raw device clock for this calculation.
      target +=
        (Math.max(0, serverNow - playbackStart) / 1000) * playbackRate;
    }

    if (Number.isFinite(video.duration))

      target = clamp(target, 0, Math.max(0, video.duration - 0.1));

    forcePlaybackHydrationRef.current = false;

    applyingRemoteRef.current = true;

    try {

      if (Math.abs(video.currentTime - target) > 0.18)

        video.currentTime = target;

      video.playbackRate = playbackRate;

      if (state.status === "playing") {

        pendingTimerRef.current = setTimeout(

          async () => {

            try {

              await video.play();

              setPlaying(true);

            } catch {

              setNotice(

                "Your browser blocked remote playback. Press Play once to enable synchronized playback.",

              );

            } finally {

              applyingRemoteRef.current = false;

            }

          },

          Math.max(0, playbackStart - getServerNow()),

        );

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

  // Periodically checkpoint the active publisher's playback position. This
  // protects the resume point if every browser closes without an explicit leave.
  useEffect(() => {
    if (!joined || !playing) return undefined;
    const timer = setInterval(() => {
      if (
        joinedRef.current &&
        videoRef.current &&
        !videoRef.current.paused &&
        (
          latestStateRef.current?.sender === clientIdRef.current ||
          !memberList.some((member) => member.id === latestStateRef.current?.sender)
        )
      ) {
        publishState("playing");
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [joined, playing, memberList, publishState]);

  const loadRemoteVideo = useCallback(async (media, user, targetRoom) => {

    if (!media?.key || !user || !targetRoom || !WORKER_URL) return;

    const requestId = `${targetRoom}:${media.key}`;

    if (

      playbackRequestRef.current === requestId &&

      mediaKeyRef.current === media.key

    )

      return;

    playbackRequestRef.current = requestId;
    beginLoading("Preparing video");

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

      if (!response.ok)

        throw new Error(result.error || "Could not retrieve playback URL");

      if (

        currentRoomRef.current !== targetRoom ||

        playbackRequestRef.current !== requestId

      )

        return;

      mediaKeyRef.current = media.key;

      setRemoteMedia(media);

      setVideoUrl(result.playbackUrl);

      setNotice("");

    } catch (error) {

      if (playbackRequestRef.current === requestId)

        playbackRequestRef.current = null;

      console.error("Playback URL request failed:", error);

      if (currentRoomRef.current === targetRoom)

        setNotice(`Couldn't load selected video: ${error.message}`);

    } finally {

      endLoading();

    }

  }, [beginLoading, endLoading]);

  const fetchRoomLibrary = useCallback(async (targetRoom, user) => {

    if (!targetRoom || !user || !WORKER_URL) return [];

    beginLoading("Loading room library");
    try {
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

    if (!response.ok)

      throw new Error(

        result.error || `Library request failed: HTTP ${response.status}`,

      );

    const metadataSnapshot = await get(
      ref(db, `rooms/${targetRoom}/mediaMetadata`),
    );
    const metadata = metadataSnapshot.val() || {};

    const items = (result.videos || []).map((video) => {
const metadataKey = getMetadataKey(video.key);
        const legacyMetadataKey = getLegacyMetadataKey(video.key);
        const savedMetadata = metadata[metadataKey] || metadata[legacyMetadataKey] || {};
      return {
        ...video,
        ...savedMetadata,
        id: video.key,
        key: video.key,
        name: savedMetadata.name || video.name || video.key?.split("/").pop() || "Untitled video",
      };
    });

    libraryItemsRef.current = items;

    setLibrary(items);

    return items;
    } finally {
      endLoading();
    }

  }, [beginLoading, endLoading]);

  const selectLibraryVideo = useCallback(

    async (item) => {

      if (

        !joinedRef.current ||

        !currentRoomRef.current ||

        !item?.id ||

        uploading

      )

        return;

      beginLoading("Switching video");
      try {
        await set(ref(db, `rooms/${currentRoomRef.current}/activeMedia`), {

          mediaId: item.key,

          changedAt: Date.now(),

          changedBy: firebaseUser?.uid || null,

        });

        await set(ref(db, `rooms/${currentRoomRef.current}/playback`), {

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
      finally {
        endLoading();
      }
    },

    [uploading, firebaseUser, beginLoading, endLoading],

  );

  const uploadVideo = async (selected) => {

    if (!selected || !currentRoomRef.current || !firebaseUser) return;

    const fileExtension = selected.name.split(".").pop()?.toLowerCase() || "";
    const supportedVideoExtensions = new Set([
      "mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "mpeg", "mpg", "3gp",
    ]);
    const isVideoFile =
      selected.type.startsWith("video/") ||
      supportedVideoExtensions.has(fileExtension);

    if (!isVideoFile)
      return setNotice("Please choose a supported video file (including MKV).");

    if (selected.size > MAX_UPLOAD_SIZE)

      return setNotice("Video exceeds the 5 GB single-upload limit.");

    if (!WORKER_URL)

      return setNotice("VITE_WORKER_URL is missing from your frontend .env.");

    const targetRoom = currentRoomRef.current;

    setUploading(true);
    beginLoading("Uploading video");

    setUploadProgress(0);

    setNotice("Preparing upload...");

    try {

      const token = await firebaseUser.getIdToken();

      const mimeByExtension = {
        mkv: "video/x-matroska",
        avi: "video/x-msvideo",
        mov: "video/quicktime",
        webm: "video/webm",
        mp4: "video/mp4",
        m4v: "video/x-m4v",
        ogv: "video/ogg",
        mpeg: "video/mpeg",
        mpg: "video/mpeg",
        "3gp": "video/3gpp",
      };
      const contentType =
        selected.type.startsWith("video/")
          ? selected.type
          : mimeByExtension[fileExtension] || "application/octet-stream";

      const response = await fetch(`${WORKER_URL}/upload-url`, {

        method: "POST",

        headers: {

          "Content-Type": "application/json",

          Authorization: `Bearer ${token}`,

        },

        body: JSON.stringify({

          roomId: targetRoom,

          filename: selected.name,

          contentType,

        }),

      });

      const result = await response.json();

      if (!response.ok)

        throw new Error(result.error || "Could not create upload URL");

      setNotice("Uploading video to Cloudflare R2...");

      await new Promise((resolve, reject) => {

        const xhr = new XMLHttpRequest();

        xhr.open("PUT", result.uploadUrl);

        xhr.setRequestHeader("Content-Type", contentType);

        xhr.upload.onprogress = (event) => {

          if (event.lengthComputable)

            setUploadProgress(Math.round((event.loaded / event.total) * 100));

        };

        xhr.onload = () =>

          xhr.status >= 200 && xhr.status < 300

            ? resolve()

            : reject(new Error(`R2 upload failed: HTTP ${xhr.status}`));

        xhr.onerror = () =>

          reject(new Error("Network error while uploading to R2"));

        xhr.onabort = () => reject(new Error("Upload was cancelled"));

        xhr.send(selected);

      });

      if (currentRoomRef.current !== targetRoom)

        throw new Error("You left the room before the upload completed.");

      // Persist the original filename separately from the opaque R2 object key.
      if (!result.key) throw new Error("Upload URL response did not include the R2 object key.");
      const metadataKey = getMetadataKey(result.key);
      await set(ref(db, `rooms/${targetRoom}/mediaMetadata/${metadataKey}`), {
        name: selected.name,
        size: selected.size,
        contentType,
        uploadedAt: Date.now(),
        uploadedBy: firebaseUser.uid,
      });

      const items = await fetchRoomLibrary(targetRoom, firebaseUser);

      const uploadedItem = items.find((item) => item.key === result.key) || {

        id: result.key,

        key: result.key,

        name: selected.name,

        size: selected.size,

      };

      await set(ref(db, `rooms/${targetRoom}/activeMedia`), {

        mediaId: uploadedItem.key,

        changedAt: Date.now(),

        changedBy: firebaseUser.uid,

      });

      await set(ref(db, `rooms/${targetRoom}/playback`), {

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
      endLoading();
    }
  };


  const renameLibraryVideo = async (item) => {
    const nextName = window.prompt("Rename video", item.name || "");
    if (nextName === null) return;
    const cleanName = nextName.trim();
    if (!cleanName) return setNotice("Video name cannot be empty.");
    if (cleanName.length > 180) return setNotice("Video name must be 180 characters or fewer.");

    const targetRoom = currentRoomRef.current;
    if (!targetRoom || !firebaseUser) return;
    const metadataKey = getMetadataKey(item.key);
    const legacyMetadataKey = getLegacyMetadataKey(item.key);
    beginLoading("Renaming video");
    try {
      await set(ref(db, `rooms/${targetRoom}/mediaMetadata/${metadataKey}/name`), cleanName);
      if (legacyMetadataKey !== metadataKey) {
        await remove(ref(db, `rooms/${targetRoom}/mediaMetadata/${legacyMetadataKey}`));
      }
      const updated = libraryItemsRef.current.map((video) =>
        video.key === item.key ? { ...video, name: cleanName } : video
      );
      libraryItemsRef.current = updated;
      setLibrary(updated);
      if (remoteMedia?.key === item.key) setRemoteMedia((current) => ({ ...current, name: cleanName }));
      setNotice("Video renamed.");
    } catch (error) {
      setNotice(`Couldn't rename video: ${error.message}`);
    } finally {
      endLoading();
    }
  };

  const deleteLibraryVideo = async (item) => {
    const confirmed = window.confirm(
      `Delete "${item.name}" from this room? This permanently removes the uploaded file.`
    );
    if (!confirmed) return;
    const targetRoom = currentRoomRef.current;
    if (!targetRoom || !firebaseUser) return;

    beginLoading("Deleting video");
    try {
      const token = await firebaseUser.getIdToken();
      const response = await fetch(`${WORKER_URL}/delete-video`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ roomId: targetRoom, key: item.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not delete video");

      const metadataKey = getMetadataKey(item.key);
      const legacyMetadataKey = getLegacyMetadataKey(item.key);
      await remove(ref(db, `rooms/${targetRoom}/mediaMetadata/${metadataKey}`));
      if (legacyMetadataKey !== metadataKey) {
        await remove(ref(db, `rooms/${targetRoom}/mediaMetadata/${legacyMetadataKey}`));
      }

      if (activeMediaId === item.key) {
        await remove(ref(db, `rooms/${targetRoom}/activeMedia`));
        await set(ref(db, `rooms/${targetRoom}/playback`), {
          status: "paused",
          position: 0,
          playbackRate: 1,
          updatedAt: Date.now(),
          startAt: null,
          revision: Date.now() * 1000 + Math.floor(Math.random() * 1000),
          sender: clientIdRef.current,
        });
        setVideoUrl("");
        setRemoteMedia(null);
        mediaKeyRef.current = null;
        playbackRequestRef.current = null;
        setPlaying(false);
      }

      await fetchRoomLibrary(targetRoom, firebaseUser);
      setNotice("Video deleted from the room.");
    } catch (error) {
      console.error("Video deletion failed:", error);
      setNotice(`Couldn't delete video: ${error.message}`);
    } finally {
      endLoading();
    }
  };

  const joinRoom = async (id, requestedRole = "guest") => {

    if (roomJoinInProgressRef.current) return;

    if (!isFirebaseConfigured)

      return setNotice("Firebase isn't configured. Check your frontend .env.");

    if (!WORKER_URL)

      return setNotice("Configure VITE_WORKER_URL in your frontend .env.");

    if (!name.trim()) {

      setNotice("Enter your name first.");

      setRoomInput(String(id || "").toUpperCase());

      return;

    }

    const normalized = String(id || "")

      .trim()

      .toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(normalized))

      return setNotice("Room IDs must be six letters or numbers.");

    roomJoinInProgressRef.current = true;
    beginLoading("Joining your room");
    if (joinedRef.current) await leaveRoom(false);

    setNotice("");

    setConnection("connecting");

    try {

      const credential =

        firebaseUser ||

        auth.currentUser ||

        (await signInAnonymously(auth)).user;

      setFirebaseUser(credential);

      let metadataSnapshot = await get(ref(db, `roomRegistry/${normalized}`));

      if (!metadataSnapshot.exists()) {

        // Backward compatibility: register a pre-existing room the first time it is opened.

        const legacyRoom = await get(ref(db, `rooms/${normalized}`));

        if (!legacyRoom.exists() && requestedRole !== "host")

          throw new Error("That room doesn't exist. Check the party ID.");

        const legacyMetadata = {

          name: `Room ${normalized}`,

          createdAt: Date.now(),

          migrated: true,

        };

        await set(ref(db, `roomRegistry/${normalized}`), legacyMetadata);

        metadataSnapshot = await get(ref(db, `roomRegistry/${normalized}`));

      }

      const metadata = metadataSnapshot.val() || { name: `Room ${normalized}` };

      const effectiveRole =

        metadata.createdBy && metadata.createdBy === credential.uid

          ? "host"

          : requestedRole;

      const membersPath = `rooms/${normalized}/members`;
      const existingMembersSnapshot = await get(ref(db, membersPath));
      const existingMembers = existingMembersSnapshot.val() || {};
      if (Object.keys(existingMembers).length === 0) {
        const playbackRef = ref(db, `rooms/${normalized}/playback`);
        const playbackSnapshot = await get(playbackRef);
        const previousPlayback = playbackSnapshot.val();
        if (previousPlayback?.status === "playing") {
          const serverNow = getServerNow();
          // No clients are connected now, so restore the last checkpoint rather
          // than counting the offline interval as watched time.
          const pausedPosition = Number(previousPlayback.position || 0);
          const pausedState = {
            ...previousPlayback,
            status: "paused",
            position: Math.max(0, pausedPosition),
            updatedAt: serverNow,
            startAt: null,
            lastPausedAt: serverNow,
            lastPausedPosition: Math.max(0, pausedPosition),
            revision: serverNow * 1000 + Math.floor(Math.random() * 1000),
            sender: clientIdRef.current,
          };
          await set(playbackRef, pausedState);
        }
      }

      const memberRef = ref(
        db,
        `rooms/${normalized}/members/${clientIdRef.current}`,
      );

      memberRefRef.current = memberRef;

      await onDisconnect(memberRef).remove();

      await set(memberRef, {

        uid: credential.uid,

        name: name.trim(),

        role: effectiveRole,

        joinedAt: Date.now(),

      });

      currentRoomRef.current = normalized;

      forcePlaybackHydrationRef.current = true;

      latestStateRef.current = null;

      lastAppliedRef.current = 0;

      mediaKeyRef.current = null;

      playbackRequestRef.current = null;

      libraryItemsRef.current = [];

      setLibrary([]);
      setUnreadChat(false);
      lastObservedMessageIdRef.current = null;

      joinedRef.current = true;

      setRoomId(normalized);

      setRoomName(metadata.name || `Room ${normalized}`);

      setRole(effectiveRole);

      navigate(`/room/${normalized}`, { replace: true });

      const stopState = onValue(

        ref(db, `rooms/${normalized}/playback`),

        (snapshot) => {

          const value = snapshot.val();

          if (value) applyState(value);

        },

        (error) => setNotice(`Playback listener: ${error.message}`),

      );

      const stopMembers = onValue(

        ref(db, `rooms/${normalized}/members`),

        (snapshot) => {

          const value = snapshot.val() || {};
          const nextMembers = Object.entries(value).map(([id, member]) => ({ id, ...member }));
          setMemberList(nextMembers);
          const currentPlayback = latestStateRef.current;
          if (
            currentPlayback?.status === "playing" &&
            currentPlayback.sender &&
            !nextMembers.some((member) => member.id === currentPlayback.sender) &&
            nextMembers.some((member) => member.id === clientIdRef.current) &&
            videoRef.current &&
            !videoRef.current.paused
          ) {
            publishState("playing");
          }

        },

        (error) => setNotice(`Presence listener: ${error.message}`),

      );

      try {

        await fetchRoomLibrary(normalized, credential);

      } catch (error) {

        console.error("R2 library request failed:", error);

        setNotice(`Couldn't load room library: ${error.message}`);

      }

      const stopMetadata = onValue(
        ref(db, `rooms/${normalized}/mediaMetadata`),
        (snapshot) => {
          const metadata = snapshot.val() || {};
          const updated = libraryItemsRef.current.map((item) => {
            const metadataKey = getMetadataKey(item.key);
            const legacyMetadataKey = getLegacyMetadataKey(item.key);
            return {
              ...item,
              name: metadata[metadataKey]?.name || metadata[legacyMetadataKey]?.name || item.name,
            };
          });
          libraryItemsRef.current = updated;
          setLibrary(updated);
          setRemoteMedia((current) => {
            if (!current) return current;
            const match = updated.find((item) => item.key === current.key);
            return match ? { ...current, name: match.name } : current;
          });
        },
        (error) => setNotice(`Metadata listener: ${error.message}`),
      );

      const stopActiveMedia = onValue(

        ref(db, `rooms/${normalized}/activeMedia`),

        async (snapshot) => {

          const selection = snapshot.val();

          if (!selection?.mediaId) {
            setActiveMediaId(null);
            setVideoUrl("");
            setRemoteMedia(null);
            mediaKeyRef.current = null;
            playbackRequestRef.current = null;
            setPlaying(false);
            return;
          }

          const selectedKey = selection.mediaId;

          setActiveMediaId(selectedKey);

          try {

            let media = libraryItemsRef.current.find(

              (item) => item.key === selectedKey,

            );

            if (!media)

              media = (await fetchRoomLibrary(normalized, credential)).find(

                (item) => item.key === selectedKey,

              );

            if (!media)

              throw new Error(

                "Selected video was not found in this room's R2 library",

              );

            if (

              currentRoomRef.current !== normalized ||

              mediaKeyRef.current === media.key

            )

              return;

            lastAppliedRef.current = 0;

            playbackRequestRef.current = null;

            setPlaying(false);

            await loadRemoteVideo(media, credential, normalized);

          } catch (error) {

            console.error("Could not load selected R2 video:", error);

            setNotice(`Couldn't load selected video: ${error.message}`);

          }

        },

        (error) => setNotice(`Active video listener: ${error.message}`),

      );

      const stopMessages = onValue(

        query(ref(db, `rooms/${normalized}/messages`), limitToLast(150)),

        (snapshot) => {

          const value = snapshot.val() || {};

          setMessages(

            Object.entries(value)

              .map(([id, message]) => ({ id, ...message }))

              .sort(

                (a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0),

              ),

          );

        },

        (error) => setNotice(`Chat listener: ${error.message}`),

      );

      unsubscribersRef.current = [

        stopState,

        stopMembers,

        stopMetadata,

        stopActiveMedia,

        stopMessages,

      ];

      setJoined(true);

      setConnection("connected");

    } catch (error) {

      console.error("Room join failed:", error);

      joinedRef.current = false;

      currentRoomRef.current = "";

      setConnection("disconnected");

      setNotice(`Couldn't join the room: ${error.message}`);

      if (memberRefRef.current) {

        try {

          await remove(memberRefRef.current);

        } catch {

          // best effort

        }

        memberRefRef.current = null;

      }

      stopRoomListeners();

      if (routeRoomId) navigate("/", { replace: true });

    } finally {

      roomJoinInProgressRef.current = false;
      endLoading();
    }

  };

  const createParty = async () => {

    if (!name.trim()) return setNotice("Enter your name first.");

    if (!isFirebaseConfigured) return setNotice("Firebase isn't configured.");

    const id = makeRoomId();

    const now = Date.now();
    beginLoading("Creating your room");
    try {

      const credential =

        firebaseUser ||

        auth.currentUser ||

        (await signInAnonymously(auth)).user;

      setFirebaseUser(credential);

      await set(ref(db, `roomRegistry/${id}`), {

        name: `Room ${id}`,

        createdAt: now,

        createdBy: credential.uid,

      });

      await joinRoom(id, "host");

    } catch (error) {

      setNotice(`Couldn't create room: ${error.message}`);

    }
    finally {
      endLoading();
    }
  };

  const leaveRoom = async (goHome = true) => {
    if (goHome) beginLoading("Leaving room");

    const leavingRoomId = currentRoomRef.current;
    if (joinedRef.current && leavingRoomId) {
      try {
        const video = videoRef.current;
        const previous = latestStateRef.current || {};
        const now = getServerNow();
        let position = video && Number.isFinite(video.currentTime)
          ? video.currentTime
          : Number(previous.position || 0);
        if ((!video || !Number.isFinite(video.currentTime)) && previous.status === "playing") {
          const start = Number(previous.startAt || previous.updatedAt || now);
          position += (Math.max(0, now - start) / 1000) * Number(previous.playbackRate || 1);
        }
        const finalPosition = Math.max(0, position);
        const membersResult = await runTransaction(
          ref(db, `rooms/${leavingRoomId}/members`),
          (members) => {
            if (!members) return members;
            const nextMembers = { ...members };
            delete nextMembers[clientIdRef.current];
            return nextMembers;
          },
        );
        const remainingMembers = membersResult.snapshot.val() || {};
        if (Object.keys(remainingMembers).length === 0) {
          const playbackRef = ref(db, `rooms/${leavingRoomId}/playback`);
          const oldPlayback = (await get(playbackRef)).val() || previous;
          const pausedState = {
            ...oldPlayback,
            status: "paused",
            position: finalPosition,
            updatedAt: now,
            startAt: null,
            lastPausedAt: now,
            lastPausedPosition: finalPosition,
            revision: now * 1000 + Math.floor(Math.random() * 1000),
            sender: clientIdRef.current,
          };
          await set(playbackRef, pausedState);
          latestStateRef.current = pausedState;
        }
        if (video && !video.paused) {
          applyingRemoteRef.current = true;
          video.pause();
          applyingRemoteRef.current = false;
        }
      } catch (error) {
        console.warn("Could not save final room playback position:", error);
      }
    }

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

    libraryItemsRef.current = [];

    latestStateRef.current = null;

    lastAppliedRef.current = 0;

    forcePlaybackHydrationRef.current = false;

    setJoined(false);

    setConnection("disconnected");

    setMemberList([]);

    setRoomId("");

    setRoomName("");

    setRole("");

    setPlaying(false);

    setRemoteMedia(null);

    setVideoUrl("");

    setLibrary([]);

    setActiveMediaId(null);

    setMessages([]);

    setUploadProgress(0);

    if (goHome) navigate("/");
    if (goHome) endLoading();

  };

  const sendMessage = async (event) => {

    event.preventDefault();

    const message = chatInput.trim();

    if (!message || !currentRoomRef.current || !firebaseUser) return;

    if (message.length > 1000)

      return setNotice("Chat messages must be 1,000 characters or fewer.");

    try {

      const messageRef = push(

        ref(db, `rooms/${currentRoomRef.current}/messages`),

      );

      await set(messageRef, {

        uid: firebaseUser.uid,

        name: name.trim(),

        text: message,

        createdAt: Date.now(),

      });

      setChatInput("");

    } catch (error) {

      setNotice(`Couldn't send message: ${error.message}`);

    }
  };

  const copyInvite = async () => {
    beginLoading("Copying invite");

    const url = `${window.location.origin}/room/${roomId}`;

    try {

      await navigator.clipboard.writeText(url);

      setCopied(true);

      setTimeout(() => setCopied(false), 1600);

    } catch {

      setNotice(`Share this link: ${url}`);

    }
    finally {
      endLoading();
    }
  };

  const onPlay = () => {

    setPlaying(true);

    if (audioContextRef.current?.state === "suspended")
      audioContextRef.current.resume().catch((error) =>
        console.warn("Audio context resume failed:", error),
      );

    if (!applyingRemoteRef.current) publishState("playing");

  };

  const onPause = () => {

    setPlaying(false);

    if (

      !applyingRemoteRef.current &&

      videoRef.current &&

      !videoRef.current.ended

    )

      publishState("paused");

  };

  const onSeeked = () => {

    if (!applyingRemoteRef.current) publishState();

  };

  const onRateChange = () => {

    if (!applyingRemoteRef.current) publishState();

  };

  const styles = `

    *{box-sizing:border-box} :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ececf2;background:#09090d;font-synthesis:none}

    body{margin:0;min-width:320px;background:radial-gradient(ellipse at 50% -25%,#242039 0%,#101017 43%,#09090d 78%)} button,input{font:inherit} button{cursor:pointer}

    .wp{min-height:100vh;color:#eeeef4}.topbar{height:68px;border-bottom:1px solid #ffffff12;background:#0b0b10dd;backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:space-between;padding:0 28px;position:sticky;top:0;z-index:20}

    .brand{display:flex;align-items:center;gap:10px;color:#f7f5ff;text-decoration:none;font-weight:850;letter-spacing:-.8px;font-size:21px}.brand-logo{width:36px;height:36px;display:block;object-fit:contain;flex:none}.accent{color:#a78bfa}.topright{display:flex;align-items:center;gap:12px;color:#a4a1b2;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:#686575;display:inline-block}.dot.online{background:#4ade80;box-shadow:0 0 12px #4ade8080}.btn{border:1px solid #ffffff18;background:#ffffff0a;color:#eeeef4;border-radius:10px;padding:10px 13px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:650;transition:.18s}.btn:hover{background:#ffffff15;border-color:#ffffff35}.btn:disabled{opacity:.45;cursor:not-allowed}.btn.primary{background:#8155e8;border-color:#936df0;color:white}.btn.primary:hover{background:#936df0}.btn.icon{width:38px;height:38px;padding:0}.home{max-width:1120px;margin:0 auto;padding:clamp(38px,8vh,90px) 24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(290px,370px);gap:54px;align-items:start}.home-main{padding-top:30px}.wordmark{font-size:clamp(42px,7vw,76px);line-height:1;font-weight:850;letter-spacing:-5px;margin:0 0 12px}.tagline{color:#a5a1b4;margin:0 0 38px;font-size:15px}.home-form{max-width:490px;display:grid;gap:13px}.field{display:grid;gap:7px}.field label{font-size:10px;letter-spacing:1.2px;font-weight:800;color:#a7a2b5}.field input,.chat-form input{background:#15141d;border:1px solid #ffffff17;border-radius:11px;padding:14px 15px;color:#f5f3ff;outline:none;width:100%}.field input:focus,.chat-form input:focus{border-color:#9b7af0;box-shadow:0 0 0 3px #8b5cf622}.home-actions{display:flex;gap:10px;margin-top:4px}.home-actions .btn{flex:1;min-height:45px}.create-room-separate{margin-top:25px;padding-top:19px;border-top:1px solid #ffffff16;display:flex;align-items:center;justify-content:space-between;gap:18px}.create-room-copy{display:grid;gap:5px;min-width:0}.create-room-copy strong{font-size:12px;color:#e9e5f2}.create-room-copy span{font-size:11px;color:#898597;line-height:1.45}.create-room-button{min-height:42px;flex:none;padding:10px 16px;border-color:#8b5cf655;background:#8b5cf615;color:#d8caff}.create-room-button:hover{background:#8b5cf629;border-color:#a78bfa}.rooms-panel{border:1px solid #ffffff14;background:#111119d9;border-radius:18px;overflow:hidden;box-shadow:0 25px 80px #0005}.panel-head{padding:18px 18px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff10}.panel-head h3{font-size:14px;margin:0}.muted{color:#858194}.room-list{max-height:470px;overflow:auto;padding:8px}.room-link{width:100%;text-align:left;border:0;background:transparent;color:#eeeef4;border-radius:10px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}.room-link:hover{background:#ffffff0b}.room-link strong{display:block;font-size:13px}.room-link small{display:block;color:#858194;font-size:11px;margin-top:4px}.empty-rooms{padding:28px 18px;text-align:center;color:#898597;font-size:12px;line-height:1.6}.notice{margin:14px 0 0;padding:11px 13px;border:1px solid #f59e0b33;background:#f59e0b0d;color:#f6ca82;border-radius:10px;font-size:12px;display:flex;gap:8px;align-items:flex-start;overflow-wrap:anywhere}.room-page{height:calc(100vh - 68px);min-height:520px;display:flex;flex-direction:column}.room-head{padding:13px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #ffffff12}.room-title{min-width:0}.room-title .kicker{color:#8d879e;font-size:9px;font-weight:800;letter-spacing:1.3px;margin:0 0 4px}.room-title h1{font-size:18px;margin:0;letter-spacing:-.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.room-title h1 span{color:#a78bfa}.room-actions{display:flex;align-items:center;gap:8px}.room-meta{display:flex;align-items:center;gap:12px;color:#9691a5;font-size:11px}.workspace{flex:1;min-height:0;display:flex;gap:0;padding:14px;overflow:hidden}.side{flex:0 0 260px;min-width:0;background:#111119;border:1px solid #ffffff12;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;transition:flex-basis .22s ease,width .22s ease}.side.right{flex-basis:285px}.side.collapsed{flex-basis:54px}.side-section{display:flex;flex-direction:column;min-height:0;flex:1;padding:12px}.side-section+ .side-section{border-top:1px solid #ffffff12}.side-section.members{flex:0 0 48%}.side-section.chat{flex:1}.side.collapsed .side-section{align-items:center;padding:10px 6px}.side-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:12px;min-height:30px}.side-head h3{font-size:12px;margin:0;white-space:nowrap}.side.collapsed .side-head{justify-content:center}.collapse-btn{border:0;background:transparent;color:#9691a5;padding:5px;border-radius:7px;display:grid;place-items:center}.collapse-btn:hover{background:#ffffff12;color:white}.side.collapsed .side-content{display:none}.member-list,.video-list{overflow:auto;min-height:0;display:grid;align-content:start;gap:5px}.member{display:flex;align-items:center;gap:9px;padding:8px;border-radius:9px;background:#ffffff05}.avatar{width:28px;height:28px;border-radius:9px;background:#30254b;color:#c9b7ff;display:grid;place-items:center;font-size:11px;font-weight:800;flex:none}.member-name{min-width:0;flex:1}.member-name strong{font-size:11px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.member-name small{font-size:10px;color:#858194}.you{font-size:9px;color:#a78bfa}.chat-messages{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:11px;padding:2px 1px 10px}.chat-icon-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}.chat-unread-dot{position:absolute;right:-4px;top:-4px;width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 2px #111119}.chat-msg{font-size:11px;line-height:1.45;overflow-wrap:anywhere}.chat-msg .sender{color:#b8a1ff;font-weight:750;margin-right:5px}.chat-msg time{color:#686477;font-size:9px;margin-left:5px}.chat-form{display:flex;gap:6px;padding-top:8px;border-top:1px solid #ffffff10}.chat-form input{padding:10px;font-size:11px;min-width:0}.chat-form button{width:36px;flex:none;padding:0}.center{flex:1;min-width:0;display:flex;flex-direction:column;padding:0 12px;gap:10px}.player-wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#050507;border:1px solid #ffffff12;border-radius:14px;overflow:hidden;position:relative}.player-wrap video{width:100%;height:100%;max-height:100%;object-fit:contain;background:#000}.empty-player{padding:30px;text-align:center;max-width:390px}.empty-player .upload-symbol{width:58px;height:58px;border-radius:18px;background:#8b5cf622;color:#bba5ff;display:grid;place-items:center;margin:0 auto 17px}.empty-player h2{font-size:18px;margin:0 0 8px}.empty-player p{font-size:12px;line-height:1.6;color:#8f8a9e;margin:0 0 17px}.player-caption{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#9994a8;font-size:11px;min-height:32px}.volume-control{display:flex;align-items:center;gap:7px;white-space:nowrap;color:#9994a8;font-size:10px}.volume-control input{width:100px;accent-color:#9b7af0;cursor:pointer}.volume-control strong{min-width:34px;text-align:right;color:#e9e5f2;font-variant-numeric:tabular-nums}.player-caption strong{color:#e9e5f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.upload-progress{height:4px;background:#ffffff14;border-radius:10px;overflow:hidden}.upload-progress>span{height:100%;display:block;background:#9b7af0}.side.right .side-section{flex:1}.video-item{width:100%;border:1px solid transparent;background:#ffffff05;color:#eeeef4;text-align:left;padding:9px;border-radius:10px;display:flex;align-items:center;gap:9px}.video-item:hover{background:#ffffff0d}.video-item.active{background:#8b5cf61b;border-color:#8b5cf655}.video-icon{width:38px;height:34px;display:grid;place-items:center;background:#24212e;border-radius:7px;color:#b7a1ff;flex:none}.video-info{min-width:0;max-width:100%;flex:1;overflow:hidden}.video-info strong{display:block;max-width:100%;min-width:0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.video-info small{display:block;color:#858194;font-size:9px;margin-top:4px}.video-row{display:flex;align-items:center;gap:3px;min-width:0;border:1px solid transparent;border-radius:10px;background:#ffffff05;padding-right:4px}.video-row.active{background:#8b5cf61b;border-color:#8b5cf655}.video-row .video-item{flex:1;min-width:0;background:transparent;border:0;padding:8px 5px}.video-row .video-item:hover{background:transparent}.video-actions{display:flex;align-items:center;gap:1px;flex:none}.video-actions .collapse-btn{padding:5px}.danger-action{color:#d88b91}.danger-action:hover{color:#ff9ca5;background:#ff536015}.selected-label{color:#bba5ff;font-size:9px}.side-empty{padding:24px 8px;text-align:center;color:#777286;font-size:11px;line-height:1.6}.side-empty svg{display:block;margin:0 auto 9px}.collapsed-rail{display:none}.side.collapsed .collapsed-rail{display:flex;flex-direction:column;gap:14px;align-items:center;color:#a69db9;padding-top:8px}.footerline{padding:7px 18px;color:#6f6a7e;font-size:10px;border-top:1px solid #ffffff0c;display:flex;justify-content:space-between}.mobile-label{display:none}

    @media(max-width:900px){.side{flex-basis:220px}.side.right{flex-basis:230px}.side.collapsed,.side.right.collapsed{flex-basis:48px}.workspace{padding:9px}.center{padding:0 8px}}

    .loading-backdrop{position:fixed;inset:0;z-index:1000;background:#08070dcc;backdrop-filter:blur(7px);display:grid;place-items:center;padding:20px;animation:fade-in .16s ease}.loading-card{width:min(300px,calc(100vw - 40px));padding:25px 22px 22px;border:1px solid #ffffff1b;border-radius:18px;background:linear-gradient(145deg,#191622,#111018);box-shadow:0 24px 90px #0009;text-align:center}.loading-orbit{width:42px;height:42px;margin:0 auto 15px;border:3px solid #ffffff17;border-top-color:#b49aff;border-right-color:#8b5cf6;border-radius:50%;animation:wp-spin .8s linear infinite}.loading-title{font-size:13px;font-weight:750;color:#f3efff}.loading-progress{height:4px;background:#ffffff18;border-radius:8px;overflow:hidden;margin-top:15px}.loading-progress span{height:100%;display:block;background:linear-gradient(90deg,#8b5cf6,#c4b5fd);transition:width .2s}.loading-subtitle{font-size:11px;color:#938da4;margin-top:6px}.loading-dots:after{content:"";animation:wp-dots 1.2s steps(4,end) infinite}@keyframes wp-spin{to{transform:rotate(360deg)}}@keyframes fade-in{from{opacity:0}to{opacity:1}}@keyframes wp-dots{0%{content:""}25%{content:"."}50%{content:".."}75%,100%{content:"..."}}.btn-loading{display:inline-flex;align-items:center;gap:7px}.mini-spinner{width:13px;height:13px;border:2px solid #ffffff50;border-top-color:#fff;border-radius:50%;display:inline-block;animation:wp-spin .7s linear infinite}
    @media(max-width:680px){.topbar{padding:0 15px}.home{grid-template-columns:1fr;gap:24px;padding:45px 17px}.home-main{padding-top:0}.wordmark{letter-spacing:-3px}.room-page{height:auto;min-height:calc(100vh - 68px)}.room-head{padding:12px}.room-meta{display:none}.workspace{display:grid;grid-template-columns:1fr;overflow:visible;padding:8px;gap:8px}.center{order:1;padding:0;min-height:45vh}.side.left{order:2;flex-basis:auto!important;display:grid;grid-template-columns:1fr 1fr;min-height:270px}.side.right{order:3;flex-basis:auto!important;min-height:180px}.side.collapsed{display:none}.side-section.members{flex:1}.side-section.chat{flex:1;border-top:0;border-left:1px solid #ffffff12}.room-actions .btn span{display:none}.room-actions .btn{padding:10px}.create-room-separate{align-items:stretch;flex-direction:column;gap:12px}.create-room-button{width:100%}.player-wrap{min-height:42vh}.footerline{font-size:9px}}

  `;

  if (!routeRoomId || !joined) {

    return (

      <div className="wp">

        <style>{styles}</style>
        {(!authReady || (roomsLoading && !!firebaseUser) || loadingMessage) && (
          <div className="loading-backdrop" role="status" aria-live="polite">
            <div className="loading-card">
              <div className="loading-orbit" />
              <div className="loading-title">{loadingMessage || "Connecting to Watchparty"}</div>
              <div className="loading-subtitle">
                {uploading ? `${uploadProgress}% uploaded` : <>Just a moment<span className="loading-dots" /></>}
              </div>
              {uploading && (
                <div className="loading-progress">
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              )}
            </div>
          </div>
        )}

        <header className="topbar">

          <a className="brand" href="/">

            <img className="brand-logo" src="/logo.png" alt="" />

            <span>

              watch<span className="accent">party</span>

            </span>

          </a>

          <div className="topright">

            <span className={`dot ${firebaseUser ? "online" : ""}`} />

            {authReady ? "Ready" : "Connecting"}

          </div>

        </header>

        <main className="home">

          <section className="home-main">

            <h1 className="wordmark">

              watch<span className="accent">party</span>

            </h1>

            <p className="tagline">

              Your room. Your people. One shared screen.

            </p>

            <div className="home-form">

              <div className="field">

                <label htmlFor="wp-name">YOUR NAME</label>

                <input

                  id="wp-name"

                  value={name}

                  onChange={(e) => setName(e.target.value)}

                  placeholder="Enter your name"

                  maxLength={24}

                  autoComplete="nickname"

                />

              </div>

              <div className="field">

                <label htmlFor="wp-room">PARTY ID</label>

                <input

                  id="wp-room"

                  value={roomInput}

                  onChange={(e) =>

                    setRoomInput(

                      e.target.value

                        .toUpperCase()

                        .replace(/[^A-Z0-9]/g, "")

                        .slice(0, 6),

                    )

                  }

                  placeholder="Enter a 6-character room ID"

                  maxLength={6}

                />

              </div>

              <div className="home-actions">

                <button

                  className="btn primary"

                  onClick={() => joinRoom(roomInput)}

                  disabled={

                    !name.trim() ||

                    roomInput.length !== 6 ||

                    connection === "connecting"

                  }

                >

                  <ArrowRight size={16} /> Join room

                </button>

              </div>

              <div className="create-room-separate">

                <div className="create-room-copy">

                  <strong>Starting a new party?</strong>

                  <span>Create a room and invite someone to join.</span>

                </div>

                <button

                  className="btn create-room-button"

                  onClick={createParty}

                  disabled={!name.trim() || connection === "connecting"}

                >

                  <Plus size={16} /> Create room

                </button>

              </div>

            </div>

            {!isFirebaseConfigured && (

              <div className="notice">

                <AlertCircle size={15} /> Firebase isn't configured. Check your

                frontend environment.

              </div>

            )}

            {notice && (

              <div className="notice">

                <AlertCircle size={15} />

                {notice}

              </div>

            )}

          </section>

          <aside className="rooms-panel">

            <div className="panel-head">

              <h3>All rooms</h3>

              <span className="muted" style={{ fontSize: 11 }}>

                {rooms.length} created

              </span>

            </div>

            <div className="room-list">

              {rooms.length ? (

                rooms.map((room) => (

                  <button

                    className="room-link"

                    key={room.id}

                    onClick={() => {

                      setRoomInput(room.id);

                      if (name.trim()) joinRoom(room.id);

                    }}

                  >

                    <span>

                      <strong>{room.name || `Room ${room.id}`}</strong>

                      <small>

                        {room.id} · Created{" "}

                        {room.createdAt

                          ? new Date(room.createdAt).toLocaleDateString()

                          : "date unavailable"}

                      </small>

                    </span>

                    <ArrowRight size={16} className="muted" />

                  </button>

                ))

              ) : (

                <div className="empty-rooms">

                  {roomsLoading && firebaseUser
                    ? "Loading rooms…"
                    : "No rooms have been created yet."}

                </div>

              )}

            </div>

          </aside>

        </main>

      </div>

    );

  }

  const roomMembers = memberList;

  return (

    <div className="wp">

      <style>{styles}</style>
        {(!authReady || (roomsLoading && !!firebaseUser) || loadingMessage) && (
          <div className="loading-backdrop" role="status" aria-live="polite">
            <div className="loading-card">
              <div className="loading-orbit" />
              <div className="loading-title">{loadingMessage || "Connecting to Watchparty"}</div>
              <div className="loading-subtitle">
                {uploading ? `${uploadProgress}% uploaded` : <>Just a moment<span className="loading-dots" /></>}
              </div>
              {uploading && (
                <div className="loading-progress">
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              )}
            </div>
          </div>
        )}

      <header className="topbar">

        <a className="brand" href="/">

          <img className="brand-logo" src="/logo.png" alt="" />

          <span>

            watch<span className="accent">party</span>

          </span>

        </a>

        <div className="topright">

          <span

            className={`dot ${connection === "connected" ? "online" : ""}`}

          />

          {connection}

        </div>

      </header>

      <main className="room-page">

        <div className="room-head">

          <div className="room-title">

            <p className="kicker">WATCH PARTY ROOM</p>

            <h1>

              {roomName || `Room ${roomId}`}

            </h1>

          </div>

          <div className="room-actions">

            <div className="room-meta">

              <span>

                <Users size={13} style={{ verticalAlign: "-2px" }} />{" "}

                {roomMembers.length} here

              </span>

              <span>{role === "host" ? "Host" : "Guest"}</span>

            </div>

            <button className="btn" onClick={copyInvite}>

              {copied ? <Check size={15} /> : <Copy size={15} />}

              <span>{copied ? "Copied" : "Invite"}</span>

            </button>

            <button

              className="btn icon"

              onClick={() => leaveRoom(true)}

              title="Leave room"

            >

              <LogOut size={16} />

            </button>

          </div>

        </div>

        <div className="workspace">

          <aside className={`side left ${leftCollapsed ? "collapsed" : ""}`}>

            {!leftCollapsed ? (

              <>

                <section className="side-section members">

                  <div className="side-head">

                    <h3>

                      <Users

                        size={14}

                        style={{ verticalAlign: "-3px", marginRight: 6 }}

                      />

                      People here ({roomMembers.length})

                    </h3>

                    <button

                      className="collapse-btn"

                      onClick={() => setLeftCollapsed(true)}

                      title="Collapse sidebar"

                    >

                      <PanelLeftClose size={16} />

                    </button>

                  </div>

                  <div className="member-list">

                    {roomMembers.map((member) => (

                      <div className="member" key={member.id}>

                        <div className="avatar">

                          {(member.name || "?").slice(0, 1).toUpperCase()}

                        </div>

                        <div className="member-name">

                          <strong>

                            {member.name || "Anonymous"}{" "}

                            {member.uid === firebaseUser?.uid && (

                              <span className="you">YOU</span>

                            )}

                          </strong>

                          <small>

                            {member.role === "host" ? "Host" : "Viewer"}

                          </small>

                        </div>

                      </div>

                    ))}

                    {!roomMembers.length && (

                      <div className="side-empty">

                        Waiting for people to join…

                      </div>

                    )}

                  </div>

                </section>

                <section className="side-section chat">

                  <div className="side-head">

                    <h3>

                      <span className="chat-icon-wrap" style={{ marginRight: 6, verticalAlign: "-3px" }}>
                        <MessageCircle size={14} />
                        {unreadChat && <span className="chat-unread-dot" />}
                      </span>

                      Room chat

                    </h3>

                  </div>

                  <div className="chat-messages">

                    {messages.map((message) => (

                      <div className="chat-msg" key={message.id}>

                        <span className="sender">

                          {message.name || "Anonymous"}

                        </span>

                        {message.text}

                        <time>

                          {message.createdAt

                            ? new Date(message.createdAt).toLocaleTimeString(

                                [],

                                { hour: "2-digit", minute: "2-digit" },

                              )

                            : ""}

                        </time>

                      </div>

                    ))}

                    {!messages.length && (

                      <div className="side-empty">Say hello to the room.</div>

                    )}

                    <div ref={chatEndRef} />

                  </div>

                  <form className="chat-form" onSubmit={sendMessage}>

                    <input

                      value={chatInput}

                      onChange={(e) => setChatInput(e.target.value)}

                      placeholder="Message the room…"

                      maxLength={1000}

                    />

                    <button

                      className="btn primary"

                      type="submit"

                      disabled={!chatInput.trim()}

                      aria-label="Send message"

                    >

                      <Send size={14} />

                    </button>

                  </form>

                </section>

              </>

            ) : (

              <div className="collapsed-rail">

                <button

                  className="collapse-btn"

                  onClick={() => setLeftCollapsed(false)}

                  title="Expand sidebar"

                >

                  <PanelLeftOpen size={18} />

                </button>

                <Users size={18} />
                <span className="chat-icon-wrap" title={unreadChat ? "Unread messages" : "Room chat"}>
                  <MessageCircle size={18} />
                  {unreadChat && <span className="chat-unread-dot" />}
                </span>

              </div>

            )}

          </aside>

          <section className="center">

            <div className="player-wrap">

              {videoUrl ? (

                <video

                  ref={videoRef}

                  key={remoteMedia?.key || videoUrl}

                  src={videoUrl}

                  crossOrigin="anonymous"

                  controls

                  playsInline

                  onLoadedMetadata={() => {

                    if (latestStateRef.current)

                      applyState(latestStateRef.current, true);

                  }}

                  onPlay={onPlay}

                  onPause={onPause}

                  onSeeked={onSeeked}

                  onRateChange={onRateChange}

                  onEnded={() => publishState("paused")}

                />

              ) : (

                <div className="empty-player">

                  <div className="upload-symbol">

                      <Upload size={25} />

                  </div>

                  <h2>
                    Add a video to the room

                  </h2>

                  <p>

                    Upload once. Everyone in this room can stream it.

                  </p>


                    <button
                      className="btn primary"

                      onClick={() => fileInputRef.current?.click()}

                      disabled={uploading}

                    >

                      <Upload size={15} />

                      {uploading ? "Uploading…" : "Upload video"}

                    </button>

                </div>

              )}

            </div>

            <input

              ref={fileInputRef}

              type="file"

              accept="video/*,.mkv,.avi,.mov,.mp4,.webm"

              hidden

              onChange={(e) => {

                const file = e.target.files?.[0];

                if (file) uploadVideo(file);

                e.target.value = "";

              }}

            />

            <div className="player-caption">

              <strong>{remoteMedia?.name || "Nothing playing"}</strong>

              <span>

                {playing ? (

                  <>

                    <Play

                      size={11}

                      fill="currentColor"

                      style={{ verticalAlign: "-2px" }}

                    />{" "}

                    Playing

                  </>

                ) : (

                  <>

                    <Pause size={11} style={{ verticalAlign: "-2px" }} /> Paused

                  </>

                )}

              </span>

              {videoUrl && (
                <label className="volume-control">
                  <span>Volume</span>
                  <input
                    aria-label="Volume percentage"
                    type="range"
                    min="0"
                    max="200"
                    step="1"
                    value={volumePercent}
                    onChange={(event) => setVolumePercent(Number(event.target.value))}
                  />
                  <strong>{volumePercent}%</strong>
                </label>
              )}

            </div>

            {uploading && (

              <div className="upload-progress">

                <span style={{ width: `${uploadProgress}%` }} />

              </div>

            )}

            {notice && (

              <div className="notice">

                <AlertCircle size={14} />

                {notice}

              </div>

            )}

          </section>

          <aside className={`side right ${rightCollapsed ? "collapsed" : ""}`}>

            {!rightCollapsed ? (

              <section className="side-section">

                <div className="side-head">

                  <h3>

                    <Library

                      size={14}

                      style={{ verticalAlign: "-3px", marginRight: 6 }}

                    />

                    Video library ({library.length})

                  </h3>

                  <div style={{ display: "flex", gap: 4 }}>

                   
                      <button
                        className="btn"
                        style={{ padding: "6px 8px", fontSize: 10, gap: 5 }}
                        onClick={() => fileInputRef.current?.click()}
                        title="Add another video to this room"
                        disabled={uploading}
                      >
                        <Plus size={13} />
                        Add video
                      </button>

                    <button

                      className="collapse-btn"

                      onClick={() => setRightCollapsed(true)}

                      title="Collapse sidebar"

                    >

                      <PanelRightClose size={16} />

                    </button>

                  </div>

                </div>

                <div className="video-list">

                  {library.map((item) => (
                    <div className={`video-row ${activeMediaId === item.id ? "active" : ""}`} key={item.id}>
                      <button
                        className="video-item"
                        onClick={() => selectLibraryVideo(item)}
                        disabled={uploading}
                        title={item.name}
                      >
                        <span className="video-icon">
                          <Film size={17} />
                        </span>
                        <span className="video-info" title={item.name}>
                          <strong>{item.name}</strong>
                          <small>{formatBytes(item.size)}</small>
                        </span>
                        {activeMediaId === item.id ? (
                          <span className="selected-label">Playing</span>
                        ) : (
                          <Play size={14} />
                        )}
                      </button>
                      
                        <div className="video-actions">
                          <button
                            className="collapse-btn"
                            onClick={() => renameLibraryVideo(item)}
                            title={`Rename ${item.name}`}
                            aria-label={`Rename ${item.name}`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="collapse-btn danger-action"
                            onClick={() => deleteLibraryVideo(item)}
                            title={`Delete ${item.name}`}
                            aria-label={`Delete ${item.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      
                    </div>
                  ))}

                  {!library.length && (

                    <div className="side-empty">

                      <Cloud size={22} />

                      No videos uploaded yet.

                      {role === "guest" && (

                        <>

                          <br />

                          The host can add videos.

                        </>

                      )}

                    </div>

                  )}

                </div>

              </section>

            ) : (

              <div className="collapsed-rail">

                <button

                  className="collapse-btn"

                  onClick={() => setRightCollapsed(false)}

                  title="Expand sidebar"

                >

                  <PanelRightOpen size={18} />

                </button>

                <Library size={18} />

              </div>

            )}

          </aside>

        </div>

        <div className="footerline">

          <span>{connection === "connected" ? "Connected" : connection}</span>

        </div>

      </main>

    </div>

  );

}

export default App;
