import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Server } from "socket.io";
import { z } from "zod";
import { authenticateSocket } from "./auth.js";
import { GENERAL, STAFF, isStaff } from "./channels.js";
import { registerHandlers } from "./handlers.js";
import { Presence } from "./presence.js";

const kickBody = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i) });

const sameSecret = (a = "", b = "") => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** HTTP + Socket.IO on one port. Returns { httpServer, io } so tests can listen on a free port. */
export function createRealtimeServer({ allowedOrigins, secret }) {
  const presence = new Presence();

  const httpServer = createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });

    // The API calls this when it deactivates someone, so they're cut off now instead of at token expiry.
    if (req.method === "POST" && req.url === "/internal/kick") {
      if (!secret || !sameSecret(req.headers["x-realtime-secret"], secret)) return json(401, { error: "Unauthorized" });
      try {
        const { userId } = kickBody.parse(await readJson(req));
        io.in(`user:${userId}`).disconnectSockets(true);
        return json(204);
      } catch {
        return json(400, { error: "Bad request" });
      }
    }
    json(404, { error: "Not found" });
  });

  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins },
    maxHttpBufferSize: 100_000, // messages are capped at 2,000 characters; nothing here needs more
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const { userId, role } = socket.data;
    // Everything here is synchronous: a client may emit the moment it connects.
    socket.join([`user:${userId}`, GENERAL, ...(isStaff({ role }) ? [STAFF] : [])]);

    if (presence.add(userId)) io.emit("presence", { userId, online: true });
    registerHandlers(io, socket, presence);

    socket.on("disconnect", () => {
      if (presence.remove(userId)) io.emit("presence", { userId, online: false });
    });
  });

  return { httpServer, io };
}
