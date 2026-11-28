/**
 * The one line chat shows after HANNAH uses a tool ("Saved to memory: …",
 * "Reminder set: …"). The model still gets the tool's full result; people see
 * what happened, not the raw JSON.
 */

const LABELS: Record<string, string> = {
  save_memory: "Saved to memory",
  search_memories: "Checked memory",
  create_reminder: "Reminder set",
  cancel_reminder: "Reminder cancelled",
  list_reminders: "Checked reminders",
  web_search: "Searched the web",
  web_read: "Read a web page",
  youtube_read_video: "Read the video's transcript",
  calendar_events: "Checked the calendar",
  calendar_create_event: "Added to the calendar",
  email_search: "Searched email",
  email_read: "Read an email",
  email_draft: "Drafted an email",
  email_reply_draft: "Drafted a reply",
  email_send: "Sent the email",
  email_needs_reply: "Checked which emails need a reply",
  email_organize: "Organized email",
  gchat_spaces: "Checked Google Chat",
  gchat_read: "Read Google Chat",
  gchat_send: "Sent the Google Chat message",
  list_app_files: "Listed files",
  read_app_file: "Read a file",
  write_app_file: "Saved a file",
  delete_app_file: "Deleted a file",
  list_workflows: "Checked automations",
  create_workflow_draft: "Drafted an automation",
};

const short = (value: string, max = 140) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function label(name: string) {
  return LABELS[name] ?? `Used ${name.replaceAll("_", " ")}`;
}

/** A short, human line for a tool's result, or for its failure. */
export function summarizeToolResult(name: string, result: unknown): string {
  const value = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  if (typeof value.error === "string") return `Couldn't finish “${name.replaceAll("_", " ")}”: ${short(value.error, 200)}`;

  switch (name) {
    case "save_memory":
      if (typeof value.content === "string") return `${label(name)}: ${short(value.content)}`;
      break;
    case "search_memories":
      if (Array.isArray(value.memories)) return value.memories.length ? `${label(name)}: ${count(value.memories.length, "memory", "memories")} found` : `${label(name)}: nothing saved about that`;
      break;
    case "create_reminder":
      if (typeof value.text === "string") return `${label(name)}: ${short(value.text, 100)}${typeof value.dueAt === "string" ? ` · ${formatWhen(value.dueAt)}` : ""}`;
      break;
    case "cancel_reminder":
      if (typeof value.text === "string") return `${label(name)}: ${short(value.text, 100)}`;
      break;
    case "list_reminders":
      if (Array.isArray(value.reminders)) return `${label(name)}: ${value.reminders.length ? `${count(value.reminders.length, "upcoming reminder")}` : "none upcoming"}`;
      break;
    case "web_search": {
      const text = typeof value.message === "string" ? value.message : "";
      const sources = (text.match(/^\[\d+\] /gm) ?? []).length;
      const query = /^Search results for “([^”]*)”/.exec(text)?.[1];
      return `${label(name)}${query ? ` for “${short(query, 80)}”` : ""}${sources ? ` · ${count(sources, "source")}` : ""}`;
    }
    case "research": {
      const text = typeof value.message === "string" ? value.message : "";
      const sources = (text.match(/^\[\d+\] /gm) ?? []).length;
      return sources ? `Researched the web · ${count(sources, "source")} read and cited` : `Research: ${short(text.split("\n")[0] ?? "", 140)}`;
    }
    case "create_document":
    case "convert_file": {
      const text = typeof value.message === "string" ? value.message : "";
      const made = /^(?:Created and validated|Converted): (.*?)\. The user/.exec(text)?.[1];
      return `${name === "convert_file" ? "Converted" : "Created"}: ${short(made || text.split("\n")[0] || "a file", 160)}`;
    }
    case "generate_image":
    case "generate_video": {
      const text = typeof value.message === "string" ? value.message : "";
      if (text.startsWith("Not made:")) return short(text.replace(/ Tell the user this plainly\.$/, ""), 160);
      return name === "generate_image" ? "Made an image" : "Made a video clip";
    }
    case "read_attached_files": {
      const text = typeof value.message === "string" ? value.message : "";
      const names = [...text.matchAll(/^FILE “([^”]*)”/gm)].map((match) => match[1]);
      return names.length ? `Read ${names.map((item) => short(item, 40)).join(", ")}` : short(text, 140);
    }
    case "web_read": {
      const text = typeof value.message === "string" ? value.message : "";
      const title = /“([^”]*)”/.exec(text.split("\n")[0] ?? "")?.[1];
      const url = /^Page (\S+)/.exec(text)?.[1];
      return `${label(name)}: ${short(title || url || "page", 100)}`;
    }
    default:
      break;
  }

  // Any other tool: its own short message, else what it returned a list of, else that it finished.
  if (typeof value.message === "string" && value.message.trim()) return `${label(name)}: ${short(value.message.split("\n")[0] ?? "")}`;
  if (typeof result === "string" && result.trim()) return `${label(name)}: ${short(result.split("\n")[0] ?? "")}`;
  const list = Object.entries(value).find(([, item]) => Array.isArray(item)) as [string, unknown[]] | undefined;
  if (list) return `${label(name)}: ${count(list[1].length, list[0].replace(/s$/, "").replaceAll("_", " "), list[0].replaceAll("_", " "))}`;
  return label(name);
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
