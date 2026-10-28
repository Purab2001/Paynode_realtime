import mongoose from "mongoose";

// The `users` collection belongs to the API. This server only reads it, so the schema lists just the
// fields chat needs and the model is never saved to.
const userSchema = new mongoose.Schema(
  {
    firebaseUid: String,
    email: String,
    name: String,
    role: String,
    photoUrl: String,
    isActive: Boolean,
  },
  { collection: "users" },
);
export const User = mongoose.models.User ?? mongoose.model("User", userSchema);

const messageSchema = new mongoose.Schema(
  {
    // "general", "staff", or "dm:<lowerUserId>:<higherUserId>".
    channel: { type: String, required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    deletedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageSchema.index({ channel: 1, createdAt: -1 });

export const Message = mongoose.models.Message ?? mongoose.model("Message", messageSchema);
