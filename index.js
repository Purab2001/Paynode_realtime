import { allowedOrigins, env } from "./src/config/env.js";
import { connectDB } from "./src/lib/db.js";
import { createRealtimeServer } from "./src/server.js";

await connectDB();

const { httpServer } = createRealtimeServer({ allowedOrigins, secret: env.REALTIME_SECRET });
httpServer.listen(env.PORT, () => console.log(`PayNode realtime running on http://localhost:${env.PORT}`));
