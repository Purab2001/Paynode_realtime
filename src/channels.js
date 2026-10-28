// Who may read and write where. Pure functions so the rules are easy to test.
//
//   general  everyone
//   staff    HR and admins
//   dm:a:b   exactly those two people, and at least one of them must be HR or an admin
//            (two Employees can't open a private chat through PayNode)

export const GENERAL = "general";
export const STAFF = "staff";

const ID = /^[a-f\d]{24}$/i;
export const CHANNEL_PATTERN = /^(general|staff|dm:[a-f\d]{24}:[a-f\d]{24})$/i;

export const isStaff = (user) => user.role === "HR" || user.role === "admin";

/** Stable channel id for a pair: the same for both people whichever of them opens it. */
export const dmChannel = (a, b) => `dm:${[String(a), String(b)].sort().join(":")}`;

export function dmParticipants(channel) {
  const [prefix, a, b] = channel.split(":");
  // Two different people: a channel pairing someone with themselves is never valid.
  return prefix === "dm" && ID.test(a) && ID.test(b) && a.toLowerCase() !== b.toLowerCase() ? [a, b] : null;
}

export const otherParticipant = (channel, userId) => dmParticipants(channel)?.find((id) => id !== String(userId));

export function canAccess(user, channel) {
  if (channel === GENERAL) return true;
  if (channel === STAFF) return isStaff(user);
  return dmParticipants(channel)?.includes(String(user.id)) ?? false;
}

/** Can `from` start or continue a private chat with `to`? */
export const canDirectMessage = (from, to) => String(from.id) !== String(to.id) && (isStaff(from) || isStaff(to));

/** Socket.IO rooms that should receive an event for this channel. */
export function recipientRooms(channel) {
  const pair = dmParticipants(channel);
  return pair ? pair.map((id) => `user:${id}`) : [channel];
}
