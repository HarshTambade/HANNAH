"use strict";

/**
 * A chat app (Slack, Microsoft Teams, Telegram, WhatsApp, …) bound to a
 * teammate. server/channels.js has already verified the platform's signature
 * and that the sender is the channel's paired owner before calling this; any
 * other person who writes to the bot never reaches here.
 *
 * The owner can:
 *   - talk to the teammate (the same conversation, limits, memory rules and
 *     proposals as in the app);
 *   - "queue": queue the task the teammate just proposed;
 *   - "approve apv_…" / "deny apv_…": decide one approval named in a
 *     notification. A decision covers that one request only;
 *   - "status": the teammate's open tasks.
 *
 * Text that arrives from anyone else, or inside a document, page or email,
 * can never decide an approval: only these exact owner commands can.
 */
const { canUseBot, clean, parse } = require("./common");
const { decideApproval } = require("./approvals");

const APPROVAL = /^\s*(approve|allow|deny|decline)\s+(apv_[A-Za-z0-9_-]{6,80})\s*[.!]?\s*$/i;
const QUEUE = /^\s*(queue|queue it|yes,? queue it|start it)\s*[.!]?\s*$/i;
const STATUS = /^\s*(status|tasks|what are you working on\??)\s*$/i;

async function ownerMessage(db, { userId, botId, text, label = "chat" }) {
  const bot = await canUseBot(db, userId, botId);
  if (!bot) return "The teammate this chat was connected to is no longer available. Choose another one in HANNAH → AI Workforce.";
  if (bot.status === "paused") return `${bot.name} is paused. Resume it in HANNAH → AI Workforce to talk here.`;
  const content = clean(text, 8000);

  const approval = APPROVAL.exec(content);
  if (approval) {
    const decision = /^(approve|allow)$/i.test(approval[1]) ? "allow" : "deny";
    try {
      const result = await decideApproval(db, userId, approval[2], decision, { reason: `Decided in ${label}`, via: label });
      return decision === "allow"
        ? `Allowed: ${result.approval.title}.${result.resume ? " The task continues on the server." : ""}`
        : `Denied: ${result.approval.title}. Nothing was done.`;
    } catch (error) {
      return error.reason ? error.message : "That approval couldn't be decided just now.";
    }
  }

  const { acceptProposal, converse, openTasksFor } = require("./conversations");
  if (QUEUE.test(content)) {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_messages WHERE user_id = $1 AND bot_id = $2 AND kind = 'proposal' ORDER BY created_at DESC LIMIT 1", [userId, bot.id]);
    const latest = rows[0];
    if (!latest || parse(latest.data, {})?.proposal?.status !== "proposed") return `There's no proposed task from ${bot.name} waiting to be queued.`;
    try {
      const accepted = await acceptProposal(db, userId, bot, latest);
      return `Queued for ${bot.name}: "${accepted.task.title}". I'll tell you here if it needs your approval.`;
    } catch (error) {
      return error.reason ? error.message : "That task couldn't be queued just now.";
    }
  }

  if (STATUS.test(content)) {
    const tasks = await openTasksFor(db, userId, bot.id);
    if (!tasks.length) return `${bot.name} has no open tasks.`;
    return [`${bot.name}'s open tasks:`, ...tasks.slice(0, 10).map((task) => `• ${task.title} (${task.status === "waiting-approval" ? "waiting for your approval" : task.status})`)].join("\n");
  }

  try {
    const result = await converse(db, userId, bot, { content });
    const last = result.messages[result.messages.length - 1];
    if (!result.reply) return last.content;
    const proposal = result.proposal ? `\n\nProposed task: "${result.proposal.title}". Reply "queue" to queue it.` : "";
    const remembered = parse(result.reply.data, {})?.remembered?.length ? "\n\n(Saved to my memory.)" : "";
    return `${result.reply.content}${proposal}${remembered}`;
  } catch (error) {
    return error.reason ? error.message : `${bot.name} couldn't answer just now.`;
  }
}

module.exports = { APPROVAL, ownerMessage };
