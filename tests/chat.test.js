import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as connect } from "socket.io-client";

// A token is "test:<uid>". Anything else is rejected, like an invalid Firebase token.
vi.mock("../src/lib/firebase.js", () => ({
  getFirebaseAuth: () => ({
    verifyIdToken: async (token) => {
      const [prefix, uid] = token.split(":");
      if (prefix !== "test" || !uid) throw new Error("invalid token");
      return { uid, exp: Math.floor(Date.now() / 1000) + 3600 };
    },
  }),
}));

const { createRealtimeServer } = await import("../src/server.js");
const { connectDB, disconnectDB } = await import("../src/lib/db.js");
const { User, Message } = await import("../src/models.js");

let server;
let url;
let users;
const clients = [];

const person = (uid, role = "Employee", extra = {}) => User.create({ firebaseUid: uid, email: `${uid}@company.com`, name: uid, role, isActive: true, ...extra });

/** Connect as a user and wait until the server accepts (or refuses) the connection. */
function join(uid, token = `test:${uid}`) {
  const socket = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}
const call = (socket, event, payload) => new Promise((resolve) => socket.timeout(5000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: { code: "TIMEOUT" } } : res)));
const next = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms}ms`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
/** Resolves true if the event does NOT arrive. */
const silent = (socket, event, ms = 300) =>
  new Promise((resolve) => {
    const handler = () => resolve(false);
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, ms);
  });

beforeAll(async () => {
  await connectDB();
  server = createRealtimeServer({ allowedOrigins: ["http://localhost:5173"], secret: process.env.REALTIME_SECRET });
  await new Promise((r) => server.httpServer.listen(0, r));
  url = `http://localhost:${server.httpServer.address().port}`;
});
afterAll(async () => {
  server.io.close();
  await disconnectDB();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Message.deleteMany({})]);
  users = {
    ann: await person("ann"),
    bob: await person("bob"),
    hana: await person("hana", "HR"),
    root: await person("root", "admin"),
  };
});
afterEach(() => {
  while (clients.length) clients.pop().disconnect();
});

describe("connecting", () => {
  it("refuses missing or invalid tokens", async () => {
    await expect(join("x", "")).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await expect(join("x", "garbage")).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });

  it("refuses accounts without a profile or that were deactivated", async () => {
    await expect(join("stranger")).rejects.toMatchObject({ data: { code: "PROFILE_INCOMPLETE" } });
    await person("gone", "Employee", { isActive: false });
    await expect(join("gone")).rejects.toMatchObject({ data: { code: "ACCOUNT_DEACTIVATED" } });
  });
});

describe("general channel", () => {
  it("delivers messages live to everyone and keeps history", async () => {
    const [ann, bob] = await Promise.all([join("ann"), join("bob")]);
    const incoming = next(bob, "message:new");
    const sent = await call(ann, "message:send", { channel: "general", text: "  Morning all  " });

    expect(sent.ok).toBe(true);
    expect(sent.message).toMatchObject({ text: "Morning all", sender: { name: "ann", role: "Employee" } });
    expect((await incoming).id).toBe(sent.message.id);

    const history = await call(bob, "messages:history", { channel: "general" });
    expect(history.messages.map((m) => m.text)).toEqual(["Morning all"]);
    expect(history.hasMore).toBe(false);
  });

  it("validates messages", async () => {
    const ann = await join("ann");
    expect((await call(ann, "message:send", { channel: "general", text: "   " })).error.code).toBe("INVALID");
    expect((await call(ann, "message:send", { channel: "general", text: "x".repeat(2001) })).error.code).toBe("INVALID");
    expect((await call(ann, "message:send", { channel: "../etc", text: "hi" })).error.code).toBe("INVALID");
    expect(await Message.countDocuments()).toBe(0);
  });

  it("pages through history 30 at a time, oldest first", async () => {
    const ann = await join("ann");
    for (let i = 1; i <= 35; i += 1) await Message.create({ channel: "general", sender: users.ann._id, text: `m${i}` });

    const first = await call(ann, "messages:history", { channel: "general" });
    expect(first.messages).toHaveLength(30);
    expect(first.messages[0].text).toBe("m6");
    expect(first.messages.at(-1).text).toBe("m35");
    expect(first.hasMore).toBe(true);

    const older = await call(ann, "messages:history", { channel: "general", before: first.messages[0].id });
    expect(older.messages.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(older.hasMore).toBe(false);
  });

  it("rate limits a flood from one connection", async () => {
    const ann = await join("ann");
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await call(ann, "message:send", { channel: "general", text: `spam ${i}` }));
    expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
    expect(results[10].error.code).toBe("RATE_LIMITED");
  });
});

describe("staff channel", () => {
  it("is closed to Employees and open to HR and admins", async () => {
    const [ann, hana, root] = await Promise.all([join("ann"), join("hana"), join("root")]);
    expect((await call(ann, "message:send", { channel: "staff", text: "hello?" })).error.code).toBe("FORBIDDEN");
    expect((await call(ann, "messages:history", { channel: "staff" })).error.code).toBe("FORBIDDEN");

    const heard = next(root, "message:new");
    expect((await call(hana, "message:send", { channel: "staff", text: "Payroll is ready" })).ok).toBe(true);
    expect((await heard).text).toBe("Payroll is ready");
    expect(await silent(ann, "message:new")).toBe(true);
  });

  it("lists the Staff channel only for staff", async () => {
    const [ann, hana] = await Promise.all([join("ann"), join("hana")]);
    expect((await call(ann, "channels:list")).channels.map((c) => c.id)).toEqual(["general"]);
    expect((await call(hana, "channels:list")).channels.map((c) => c.id)).toEqual(["general", "staff"]);
  });
});

describe("direct messages", () => {
  const dm = (a, b) => `dm:${[String(users[a]._id), String(users[b]._id)].sort().join(":")}`;

  it("works between an Employee and HR, privately", async () => {
    const [ann, hana, bob] = await Promise.all([join("ann"), join("hana"), join("bob")]);
    const heard = next(hana, "message:new");
    const sent = await call(ann, "message:send", { channel: dm("ann", "hana"), text: "Question about my payslip" });
    expect(sent.ok).toBe(true);
    expect((await heard).text).toBe("Question about my payslip");

    // Another employee can neither read nor write it, and gets no live event.
    expect((await call(bob, "messages:history", { channel: dm("ann", "hana") })).error.code).toBe("FORBIDDEN");
    expect((await call(bob, "message:send", { channel: dm("ann", "hana"), text: "me too" })).error.code).toBe("FORBIDDEN");
    expect(await silent(bob, "message:new")).toBe(true);

    // The conversation now shows up for both sides, named after the other person.
    const mine = (await call(ann, "channels:list")).channels.find((c) => c.type === "dm");
    expect(mine).toMatchObject({ id: dm("ann", "hana"), name: "hana" });
    expect((await call(hana, "channels:list")).channels.find((c) => c.type === "dm").name).toBe("ann");
  });

  it("is not available between two Employees", async () => {
    const ann = await join("ann");
    const res = await call(ann, "message:send", { channel: dm("ann", "bob"), text: "psst" });
    expect(res.error.code).toBe("FORBIDDEN");
  });

  it("offers each person only the people they may message", async () => {
    const [ann, hana] = await Promise.all([join("ann"), join("hana")]);
    expect((await call(ann, "people:list")).people.map((p) => p.name).sort()).toEqual(["hana", "root"]);
    expect((await call(hana, "people:list")).people.map((p) => p.name).sort()).toEqual(["ann", "bob", "root"]);
  });
});

describe("deleting", () => {
  it("lets people delete their own messages and admins moderate shared channels", async () => {
    const [ann, bob, root] = await Promise.all([join("ann"), join("bob"), join("root")]);
    const { message } = await call(ann, "message:send", { channel: "general", text: "oops" });

    expect((await call(bob, "message:delete", { id: message.id })).error.code).toBe("FORBIDDEN");

    const gone = next(bob, "message:deleted");
    expect((await call(ann, "message:delete", { id: message.id })).ok).toBe(true);
    expect(await gone).toEqual({ id: message.id, channel: "general" });

    const history = await call(bob, "messages:history", { channel: "general" });
    expect(history.messages[0]).toMatchObject({ deleted: true, text: "" });

    const second = await call(bob, "message:send", { channel: "general", text: "rude" });
    expect((await call(root, "message:delete", { id: second.message.id })).ok).toBe(true);
  });

  it("does not let admins moderate private messages", async () => {
    const [ann, root] = await Promise.all([join("ann"), join("root")]);
    const channel = `dm:${[String(users.ann._id), String(users.hana._id)].sort().join(":")}`;
    const { message } = await call(ann, "message:send", { channel, text: "private" });
    expect((await call(root, "message:delete", { id: message.id })).error.code).toBe("FORBIDDEN");
  });
});

describe("typing and presence", () => {
  it("tells others who is typing, but not the typist", async () => {
    const [ann, bob] = await Promise.all([join("ann"), join("bob")]);
    const seen = next(bob, "typing");
    await call(ann, "typing", { channel: "general", typing: true });
    expect(await seen).toMatchObject({ channel: "general", typing: true, user: { name: "ann" } });
    expect(await silent(ann, "typing")).toBe(true);
  });

  it("announces people coming and going once, however many tabs they have", async () => {
    const hana = await join("hana");
    const online = next(hana, "presence");
    const ann1 = await join("ann");
    expect(await online).toEqual({ userId: String(users.ann._id), online: true });

    const ann2 = await join("ann");
    expect((await call(hana, "people:list")).people.find((p) => p.name === "ann").online).toBe(true);

    ann1.disconnect();
    expect(await silent(hana, "presence")).toBe(true); // still has a second tab open

    const offline = next(hana, "presence");
    ann2.disconnect();
    expect(await offline).toEqual({ userId: String(users.ann._id), online: false });
  });
});

describe("revoking access", () => {
  it("cuts off a deactivated user on their next action", async () => {
    const ann = await join("ann");
    await User.updateOne({ _id: users.ann._id }, { isActive: false });
    const res = await call(ann, "message:send", { channel: "general", text: "still here?" });
    expect(res.error.code).toBe("ACCOUNT_DEACTIVATED");
    await new Promise((r) => setTimeout(r, 100));
    expect(ann.connected).toBe(false);
  });

  it("can be disconnected immediately by the API with the shared secret", async () => {
    const ann = await join("ann");
    const closed = new Promise((resolve) => ann.on("disconnect", resolve));
    const kick = (secret) =>
      fetch(`${url}/internal/kick`, { method: "POST", headers: { "x-realtime-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ userId: String(users.ann._id) }) });

    expect((await kick("wrong-secret")).status).toBe(401);
    expect(ann.connected).toBe(true);
    expect((await kick(process.env.REALTIME_SECRET)).status).toBe(204);
    expect(await closed).toBe("io server disconnect");
  });

  it("serves a health check", async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
  });
});
