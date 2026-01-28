/**
 * Telegram integration
 */

import axios from "axios";
import { chunkText } from "../utils/formatters.js";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

export async function sendTelegram(html) {
  const parts = chunkText(html);
  for (const p of parts) {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: p,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 15000 }
    );
  }
}
