import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MESSAGE_LIMIT = 1900;

export function splitDiscordMessage(message, limit = MESSAGE_LIMIT) {
  const chunks = [];
  let current = "";

  for (const line of message.trim().split("\n")) {
    if (line.length > limit) {
      if (current) chunks.push(current);
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      current = "";
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function sendDiscordAlert(webhookUrl, message, fetchImpl = fetch) {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");

  for (const content of splitDiscordMessage(message)) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Providence Job Monitor",
        content,
        allowed_mentions: { parse: [] },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Discord webhook failed (${response.status}): ${await response.text()}`,
      );
    }
  }
}

async function main() {
  const [alertPath] = process.argv.slice(2);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!alertPath) throw new Error("Usage: send-discord.mjs ALERT_PATH");
  if (!webhookUrl) {
    console.log("DISCORD_WEBHOOK_URL is not configured; skipping Discord alert.");
    return;
  }

  const message = await readFile(alertPath, "utf8");
  await sendDiscordAlert(webhookUrl, message);
  console.log("Discord alert sent.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
