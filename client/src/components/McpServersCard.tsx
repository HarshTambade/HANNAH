import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { getApiAccessToken } from "../services/api";
import { refreshMcpTools, type McpServerInfo } from "../services/McpTools";

const example = `HANNAH_MCP_SERVERS=[{"id":"docs","name":"Team docs","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer …"}}]`;

/** Outside MCP servers HANNAH can use as tools (operator only). */
export default function McpServersCard() {
  const operator = Boolean(getApiAccessToken());
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  useEffect(() => {
    if (operator) void refreshMcpTools().then(setServers);
  }, [operator]);

  return (
    <section className="mt-6 rounded-[1.75rem] border-[6px] border-white/90 bg-white p-5 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.35)] sm:p-7" aria-label="MCP servers HANNAH uses">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-100 bg-violet-50 text-violet-600"><Network size={19} /></span>
        <div className="min-w-0">
          <h2 className="font-['Manrope'] text-lg font-semibold text-ink">Tools from other MCP servers</h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">HANNAH can also be an MCP client. Tools from the servers you list become available in chat; the Guardian reviews every call and you approve each one, because HANNAH can't know what an outside tool changes. Only sessions with the operator's access token can use them.</p>
        </div>
      </div>
      <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-2xl bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">{example}</pre>
      <p className="mt-2 text-xs text-slate-500">Streamable HTTP servers only. URLs must be https (http only on localhost).</p>
      {operator && servers && (
        servers.length === 0
          ? <p className="mt-3 text-sm text-slate-500">No MCP servers are configured on this server yet.</p>
          : (
            <ul className="mt-3 space-y-2" aria-label="Connected MCP servers">
              {servers.map((server) => (
                <li key={server.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                  <p className="font-medium text-ink">{server.name} <span className={`ml-1 text-xs ${server.ok ? "text-emerald-700" : "text-rose-700"}`}>{server.ok ? `${server.tools.length} tools` : server.error}</span></p>
                  {server.ok && <p className="mt-1 text-xs text-slate-500">{server.tools.map((tool) => tool.name).join(", ")}</p>}
                </li>
              ))}
            </ul>
          )
      )}
    </section>
  );
}
