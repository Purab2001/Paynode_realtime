# PayNode realtime (team chat)

Socket.IO server for PayNode chat. Verifies the same Firebase ID tokens as the API and shares its MongoDB.
It needs a host that keeps a process running (Render, Railway, Fly.io). **Not Vercel**: serverless functions cannot hold WebSocket connections.

```bash
cp .env.example .env     # fill in the values
npm install
npm run dev              # http://localhost:5001  (health check: /health)
npm test
```

Channels: `general` (everyone), `staff` (HR and admins), and private DMs (at least one side must be HR or an admin).
Run a single instance: presence is kept in memory. Set `REALTIME_SECRET` here and on the API so deactivated users are disconnected immediately.
