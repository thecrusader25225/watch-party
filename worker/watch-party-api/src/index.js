import {

  S3Client,

  PutObjectCommand,

  GetObjectCommand,

  HeadObjectCommand,
  DeleteObjectCommand,

} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { createRemoteJWKSet, jwtVerify } from "jose";
// --------------------------------------------------// CONFIGURATION// --------------------------------------------------
const BUCKET = "watch-party-media";

const UPLOAD_EXPIRY = 3600;

const PLAYBACK_EXPIRY = 43200;

const FIREBASE_KEYS = createRemoteJWKSet(

  new URL(

    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"

  )

);
// --------------------------------------------------// CORS// --------------------------------------------------
function corsHeaders(request, env) {

  const origin = request.headers.get("Origin") || "";

  const allowedOrigins = [

    env.APP_ORIGIN,

    "https://watch-party-one-livid.vercel.app",

    "http\://localhost:5173",

    "http\://127.0.0.1:5173",

  ].filter(Boolean);

  return {

    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)

      ? origin

      : "",

    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers": "Content-Type, Authorization",

    "Access-Control-Max-Age": "86400",

    Vary: "Origin",

  };

}

function json(data, status, headers) {

  return new Response(JSON.stringify(data), {

    status,

    headers: {

      ...headers,

      "Content-Type": "application/json",

    },

  });

}
// --------------------------------------------------// R2 S3 CLIENT// Used for signed uploads and playback URLs.// --------------------------------------------------
function getS3(env) {

  return new S3Client({

    region: "auto",

    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,

    credentials: {

      accessKeyId: env.R2_ACCESS_KEY_ID,

      secretAccessKey: env.R2_SECRET_ACCESS_KEY,

    },

  });

}
// --------------------------------------------------// FIREBASE AUTHENTICATION// --------------------------------------------------
async function authenticate(request, env) {

  const header = request.headers.get("Authorization") || "";

  const token = header.startsWith("Bearer ")

    ? header.slice(7)

    : null;

  if (!token) {

    throw new Error("Missing Firebase authentication token");

  }

  const { payload } = await jwtVerify(token, FIREBASE_KEYS, {

    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,

    audience: env.FIREBASE_PROJECT_ID,

  });

  return {

    uid: payload.sub,

    token,

  };

}
// --------------------------------------------------// ROOM MEMBERSHIP// --------------------------------------------------
async function getMembership(roomId, user, env) {

  const base = env.FIREBASE_DATABASE_URL.replace(/\/$/, "");

  const url =

    `${base}/rooms/${encodeURIComponent(roomId)}/members.json` +

    `?auth=${encodeURIComponent(user.token)}`;

  const response = await fetch(url);

  if (!response.ok) {

    throw new Error("Could not verify room membership");

  }

  const members = await response.json();

  if (!members) {

    throw new Error("Room does not exist");

  }

  const member = Object.values(members).find(

    (item) => item && item.uid === user.uid

  );

  if (!member) {

    throw new Error("You are not a member of this room");

  }

  return member;

}

function validateRoomId(roomId) {

  return (

    typeof roomId === "string" &&

    /^[A-Z0-9]{6}$/.test(roomId)

  );

}
// --------------------------------------------------// LIST VIDEOS FROM R2// Uses native Cloudflare R2 binding.// No AWS XML parsing / DOMParser required.// --------------------------------------------------
async function listRoomVideos(bucket, roomId) {

  const prefix = `rooms/${roomId}/`;

  const videos = [];

  let cursor;

  do {

    const result = await bucket.list({

      prefix,

      limit: 1000,

      cursor,

    });

    for (const object of result.objects) {

      if (object.key.endsWith("/")) continue;

      videos.push({

        id: object.key,

        key: object.key,

        name: object.key.split("/").pop(),

        size: object.size,

        uploadedAt: object.uploaded

          ? new Date(object.uploaded).getTime()

          : null,

      });

    }

    cursor = result.truncated ? result.cursor : undefined;

  } while (cursor);

  videos.sort(

    (a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0)

  );

  return videos;

}
// --------------------------------------------------// WORKER ROUTES// --------------------------------------------------
export default {

  async fetch(request, env) {

    const headers = corsHeaders(request, env);

    const origin = request.headers.get("Origin");
// CORS preflight
    if (request.method === "OPTIONS") {

      if (

        origin &&

        !headers["Access-Control-Allow-Origin"]

      ) {

        return new Response("Origin not allowed", {

          status: 403,

        });

      }

      return new Response(null, {

        status: 204,

        headers,

      });

    }

    if (

      origin &&

      !headers["Access-Control-Allow-Origin"]

    ) {

      return json(

        { error: "Origin not allowed" },

        403,

        headers

      );

    }

    const url = new URL(request.url);
// Health check
    if (

      request.method === "GET" &&

      url.pathname === "/health"

    ) {

      return json(

        {

          service: "watch-party-api",

          status: "running",

        },

        200,

        headers

      );

    }

    try {

      if (request.method !== "POST") {

        return json(

          { error: "Method not allowed" },

          405,

          headers

        );

      }
// Authenticate user
      const user = await authenticate(request, env);

      const body = await request.json();

      const { roomId } = body;

      if (!validateRoomId(roomId)) {

        return json(

          { error: "Invalid room ID" },

          400,

          headers

        );

      }
// Verify room membership
      await getMembership(roomId, user, env);
// --------------------------------------------// POST /upload-url// --------------------------------------------
      if (url.pathname === "/upload-url") {

        const member = await getMembership(roomId, user, env);

        if (member.role !== "host") {

          return json(

            { error: "Only the host can upload videos" },

            403,

            headers

          );

        }

        const filename = String(

          body.filename || "video"

        ).split(/[\\\/]/).pop();

        const contentType = String(

          body.contentType || ""

        );

        if (!contentType.startsWith("video/")) {

          return json(

            { error: "Only video files are allowed" },

            400,

            headers

          );

        }

        const extension = filename.includes(".")

          ? filename

              .split(".")

              .pop()

              .toLowerCase()

              .replace(/[^a-z0-9]/g, "")

              .slice(0, 10)

          : "mp4";

        const key =

          `rooms/${roomId}/${crypto.randomUUID()}.${extension || "mp4"}`;

        const s3 = getS3(env);

        const command = new PutObjectCommand({

          Bucket: BUCKET,

          Key: key,

          ContentType: contentType,

        });

        const uploadUrl = await getSignedUrl(

          s3,

          command,

          {

            expiresIn: UPLOAD_EXPIRY,

          }

        );

        return json(

          {

            uploadUrl,

            key,

            expiresIn: UPLOAD_EXPIRY,

          },

          200,

          headers

        );

      }
// --------------------------------------------// POST /list-videos// --------------------------------------------
      if (url.pathname === "/list-videos") {

        if (!env.MEDIA_BUCKET) {

          throw new Error(

            "MEDIA_BUCKET R2 binding is missing"

          );

        }

        const videos = await listRoomVideos(

          env.MEDIA_BUCKET,

          roomId

        );

        return json(

          {

            roomId,

            count: videos.length,

            videos,

          },

          200,

          headers

        );

      }
// --------------------------------------------// POST /playback-url// --------------------------------------------
      // POST /delete-video: host-only permanent deletion from this room's R2 prefix.
      if (url.pathname === "/delete-video") {
        const member = await getMembership(roomId, user, env);

        if (member.role !== "host") {
          return json(
            { error: "Only the host can delete videos" },
            403,
            headers
          );
        }

        const key = body.key;
        if (
          typeof key !== "string" ||
          !key.startsWith(`rooms/${roomId}/`) ||
          key.includes("..") ||
          key.endsWith("/")
        ) {
          return json({ error: "Invalid video key" }, 400, headers);
        }

        const s3 = getS3(env);
        await s3.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: key,
          })
        );

        return json({ deleted: true, key }, 200, headers);
      }

      if (url.pathname === "/playback-url") {

        const key = body.key;

        if (

          typeof key !== "string" ||

          !key.startsWith(`rooms/${roomId}/`) ||

          key.includes("..")

        ) {

          return json(

            { error: "Invalid video key" },

            400,

            headers

          );

        }

        const s3 = getS3(env);

        await s3.send(

          new HeadObjectCommand({

            Bucket: BUCKET,

            Key: key,

          })

        );

        const command = new GetObjectCommand({

          Bucket: BUCKET,

          Key: key,

        });

        const playbackUrl = await getSignedUrl(

          s3,

          command,

          {

            expiresIn: PLAYBACK_EXPIRY,

          }

        );

        return json(

          {

            playbackUrl,

            expiresIn: PLAYBACK_EXPIRY,

          },

          200,

          headers

        );

      }

      return json(

        { error: "Not found" },

        404,

        headers

      );

    } catch (error) {

      console.error("Worker error:", error);

      const message =

        error.code === "ERR_JWT_EXPIRED"

          ? "Firebase session expired"

          : error.message || "Internal server error";

      let status = 500;

      if (

        message.includes("not a member") ||

        message.includes("Only the host")

      ) {

        status = 403;

      } else if (

        message.includes("Missing Firebase")

      ) {

        status = 401;

      } else if (

        message.includes("Invalid")

      ) {

        status = 400;

      }

      return json(

        { error: message },

        status,

        headers

      );

    }

  },

};
