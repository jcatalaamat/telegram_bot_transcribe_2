const { TELEGRAM_BOT_TOKEN, OPENAI_API_KEY } = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — OpenAI Whisper limit

// --- Telegram helpers ---

async function sendMessage(chatId, text, replyToMessageId) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
    }),
  });
}

async function sendChatAction(chatId, action = "typing") {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

async function getFileUrl(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json();
  if (!data.ok) return null;
  return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
}

// --- Core logic ---

async function transcribe(fileUrl) {
  // Download from Telegram
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  const audioBlob = await response.blob();

  // Send to OpenAI Whisper via raw fetch (SDK has issues on Vercel)
  const form = new FormData();
  form.append("file", audioBlob, "audio.ogg");
  form.append("model", "whisper-1");

  const result = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!result.ok) {
    const err = await result.text();
    throw new Error(`OpenAI API error ${result.status}: ${err}`);
  }

  const data = await result.json();
  return data.text;
}

function extractAudio(message) {
  // Voice message (most common)
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size,
      duration: message.voice.duration,
    };
  }

  // Video note (round video messages — they have audio)
  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      fileSize: message.video_note.file_size,
      duration: message.video_note.duration,
    };
  }

  // Audio file (music, podcasts, etc.)
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size,
      duration: message.audio.duration,
    };
  }

  // Video (WhatsApp forwards often come as video with audio)
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileSize: message.video.file_size,
      duration: message.video.duration,
    };
  }

  // Document that's actually an audio or video file
  if (
    message.document &&
    (message.document.mime_type?.startsWith("audio/") ||
      message.document.mime_type?.startsWith("video/"))
  ) {
    return {
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
    };
  }

  return null;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

  // /start command — only in DMs
  if (message.text === "/start" && !isGroup) {
    await sendMessage(
      chatId,
      "Send me a voice message and I'll transcribe it for you. Also works in group chats — just add me to a group."
    );
    return;
  }

  // Check the message itself, or a forwarded message that might contain audio
  const audio = extractAudio(message);
  if (!audio) return;

  // File size check
  if (audio.fileSize && audio.fileSize > MAX_FILE_SIZE) {
    await sendMessage(
      chatId,
      "That file is too large for me to transcribe (max 25MB).",
      message.message_id
    );
    return;
  }

  // Show "typing..." indicator
  await sendChatAction(chatId);

  try {
    const fileUrl = await getFileUrl(audio.fileId);
    if (!fileUrl) {
      await sendMessage(chatId, "Couldn't retrieve the file from Telegram.", message.message_id);
      return;
    }

    const text = await transcribe(fileUrl);

    if (!text || text.trim().length === 0) {
      await sendMessage(chatId, "No speech detected.", message.message_id);
      return;
    }

    await sendMessage(chatId, text, message.message_id);
  } catch (err) {
    console.error("Transcription error:", err?.message || err, err?.response?.data || "");
    await sendMessage(chatId, "Something went wrong with the transcription.", message.message_id);
  }
}

// --- Vercel handler ---

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, channel_post } = req.body;
    const msg = message || channel_post;
    if (msg) {
      await handleMessage(msg);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  // Always return 200 to Telegram — otherwise it retries
  res.status(200).json({ ok: true });
}
