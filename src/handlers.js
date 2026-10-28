import { z } from "zod";
import { CHANNEL_PATTERN, GENERAL, STAFF, canAccess, canDirectMessage, dmChannel, isStaff, otherParticipant, recipientRooms } from "./channels.js";
import { Message, User } from "./models.js";

const PAGE = 30;
const SEND_LIMIT = { count: 10, windowMs: 10_000 };

const channelId = z.string().regex(CHANNEL_PATTERN, "Unknown channel");
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const schemas = {
  history: z.object({ channel: channelId, before: objectId.optional() }),
  send: z.object({ channel: channelId, text: z.string().trim().min(1, "Write a message first").max(2000, "Messages can be up to 2,000 characters") }),
  remove: z.object({ id: objectId }),
  typing: z.object({ channel: channelId, typing: z.boolean() }),
};

class ChatError extends Error {
  /** `disconnect` drops the connection after the error has been acknowledged. */
  constructor(code, message, { disconnect = false } = {}) {
    super(message);
    this.code = code;
    this.disconnect = disconnect;
  }
}

const publicUser = (u, online) => ({ id: String(u._id), name: u.name, photoUrl: u.photoUrl ?? "", role: u.role, ...(online !== undefined && { online }) });

export const serializeMessage = (m, sender) => ({
  id: String(m._id),
  channel: m.channel,
  sender: publicUser(sender),
  // Deleted messages keep their place in the history but lose their text.
  text: m.deletedAt ? "" : m.text,
  deleted: !!m.deletedAt,
  createdAt: m.createdAt.toISOString(),
});

/** Wire up one connected socket. Every handler acknowledges with { ok, ... } or { ok: false, error }. */
export function registerHandlers(io, socket, presence) {
  const { userId } = socket.data;
  const sentAt = [];

  /** Load the caller fresh so a deactivation or role change takes effect on the very next action. */
  async function currentUser() {
    if (Date.now() / 1000 > socket.data.tokenExp) {
      // The client reconnects with a fresh token.
      throw new ChatError("TOKEN_EXPIRED", "Your session expired. Reconnecting…", { disconnect: true });
    }
    const me = await User.findById(userId).select("name role photoUrl isActive");
    if (!me || !me.isActive) throw new ChatError("ACCOUNT_DEACTIVATED", "This account has been deactivated.", { disconnect: true });
    return me;
  }

  const on = (event, schema, handler) =>
    socket.on(event, async (payload, cb) => {
      const ack = typeof cb === "function" ? cb : () => {};
      try {
        const input = schema ? schema.parse(payload ?? {}) : undefined;
        ack({ ok: true, ...(await handler(input, await currentUser())) });
      } catch (err) {
        if (err instanceof z.ZodError) return ack({ ok: false, error: { code: "INVALID", message: err.issues[0]?.message ?? "Invalid request." } });
        if (err instanceof ChatError) {
          ack({ ok: false, error: { code: err.code, message: err.message } });
          if (err.disconnect) socket.disconnect(true);
          return;
        }
        console.error(`Chat handler "${event}" failed:`, err);
        ack({ ok: false, error: { code: "SERVER_ERROR", message: "Something went wrong. Please try again." } });
      }
    });

  const requireAccess = (me, channel) => {
    if (!canAccess(me, channel)) throw new ChatError("FORBIDDEN", "You don't have access to that conversation.");
  };

  on("channels:list", null, async (_input, me) => {
    const channels = [
      { id: GENERAL, type: "channel", name: "General", description: "Everyone at the company" },
      ...(isStaff(me) ? [{ id: STAFF, type: "channel", name: "Staff", description: "HR and admins only" }] : []),
    ];

    // Private conversations this person already has, most recent first.
    const convos = await Message.aggregate([
      { $match: { channel: { $regex: `^dm:.*${me.id}` } } },
      { $group: { _id: "$channel", lastAt: { $max: "$createdAt" } } },
      { $sort: { lastAt: -1 } },
      { $limit: 50 },
    ]);
    const partnerIds = convos.map((c) => otherParticipant(c._id, me.id)).filter(Boolean);
    const partners = new Map((await User.find({ _id: { $in: partnerIds } }).select("name role photoUrl")).map((u) => [String(u._id), u]));

    for (const c of convos) {
      const partner = partners.get(otherParticipant(c._id, me.id));
      if (partner) channels.push({ id: c._id, type: "dm", name: partner.name, partner: publicUser(partner, presence.has(String(partner._id))), lastAt: c.lastAt.toISOString() });
    }
    return { channels };
  });

  on("people:list", null, async (_input, me) => {
    const filter = { isActive: true, _id: { $ne: me._id }, ...(isStaff(me) ? {} : { role: { $in: ["HR", "admin"] } }) };
    const people = await User.find(filter).select("name role photoUrl").sort({ name: 1 }).limit(300);
    return { people: people.map((u) => ({ ...publicUser(u, presence.has(String(u._id))), channel: dmChannel(me.id, u._id) })) };
  });

  on("messages:history", schemas.history, async ({ channel, before }, me) => {
    requireAccess(me, channel);
    const found = await Message.find({ channel, ...(before && { _id: { $lt: before } }) })
      .sort({ _id: -1 })
      .limit(PAGE + 1)
      .populate("sender", "name role photoUrl");
    const page = found.slice(0, PAGE).reverse(); // oldest first, ready to render
    return { messages: page.map((m) => serializeMessage(m, m.sender)), hasMore: found.length > PAGE };
  });

  on("message:send", schemas.send, async ({ channel, text }, me) => {
    requireAccess(me, channel);

    if (channel.startsWith("dm:")) {
      const partner = await User.findOne({ _id: otherParticipant(channel, me.id), isActive: true }).select("role");
      if (!partner || !canDirectMessage(me, partner)) throw new ChatError("FORBIDDEN", "You can't message this person.");
    }

    const now = Date.now();
    while (sentAt.length && now - sentAt[0] > SEND_LIMIT.windowMs) sentAt.shift();
    if (sentAt.length >= SEND_LIMIT.count) throw new ChatError("RATE_LIMITED", "You're sending messages too fast. Wait a moment.");
    sentAt.push(now);

    const created = await Message.create({ channel, sender: me._id, text });
    const message = serializeMessage(created, me);
    io.to(recipientRooms(channel)).emit("message:new", message);
    return { message };
  });

  on("message:delete", schemas.remove, async ({ id }, me) => {
    const message = await Message.findById(id);
    if (!message) throw new ChatError("NOT_FOUND", "That message no longer exists.");
    requireAccess(me, message.channel);

    const isOwn = String(message.sender) === me.id;
    const moderates = me.role === "admin" && !message.channel.startsWith("dm:");
    if (!isOwn && !moderates) throw new ChatError("FORBIDDEN", "You can only delete your own messages.");

    if (!message.deletedAt) {
      message.deletedAt = new Date();
      await message.save();
      io.to(recipientRooms(message.channel)).emit("message:deleted", { id, channel: message.channel });
    }
    return {};
  });

  on("typing", schemas.typing, async ({ channel, typing }, me) => {
    requireAccess(me, channel);
    socket.to(recipientRooms(channel)).emit("typing", { channel, user: { id: me.id, name: me.name }, typing });
    return {};
  });
}
