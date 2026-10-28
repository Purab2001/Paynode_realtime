import { getFirebaseAuth } from "./lib/firebase.js";
import { User } from "./models.js";

const reject = (code, message) => Object.assign(new Error(message), { data: { code } });

/** Socket.IO middleware: the client sends a Firebase ID token in the handshake. */
export async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || !token) return next(reject("UNAUTHENTICATED", "Sign in to use chat."));

  let decoded;
  try {
    decoded = await getFirebaseAuth().verifyIdToken(token);
  } catch {
    return next(reject("UNAUTHENTICATED", "Your session has expired. Please sign in again."));
  }

  const user = await User.findOne({ firebaseUid: decoded.uid }).select("isActive role");
  if (!user) return next(reject("PROFILE_INCOMPLETE", "Finish setting up your profile to use chat."));
  if (!user.isActive) return next(reject("ACCOUNT_DEACTIVATED", "This account has been deactivated."));

  // `exp` lets handlers refuse work once the token has lapsed; the client then reconnects with a fresh one.
  socket.data = { userId: String(user._id), role: user.role, tokenExp: decoded.exp };
  next();
}
