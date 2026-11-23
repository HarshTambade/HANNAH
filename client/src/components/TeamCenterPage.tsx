/**
 * Team Center — shared teammates. A Team Bot is a published teammate the
 * team can use; each teammate keeps private conversations and memory. The
 * organization policy restricts what teammates may do even when someone
 * allows it.
 */
import { useCallback, useEffect, useState } from "react";
import { Bot as BotIcon, Crown, Lock, RefreshCw, Trash2, Users, X, Zap } from "lucide-react";
import workforce, { type Bot, type Team, type TeamMember, type WorkforceEvent } from "../services/Workforce";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const Notice = ({ tone = "slate", role, children }: { tone?: "slate" | "rose" | "amber" | "emerald"; role?: "alert" | "status"; children: React.ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={role || (tone === "rose" ? "alert" : "status")}>{children}</p>;
};
const formatTime = (at: number | null | undefined) => (at ? new Date(at).toLocaleString() : "never");

const EFFECT_TONES: Record<string, string> = { allow: "border-emerald-200 bg-emerald-50 text-emerald-800", ask: "border-amber-200 bg-amber-50 text-amber-900", deny: "border-rose-200 bg-rose-50 text-rose-900" };

type TeamDetail = { team: Team; members: TeamMember[]; bots: Bot[]; policy: PolicyRule[]; activity?: WorkforceEvent[] };
type PolicyRule = { action: string; effect: string; note: string };

/** Team detail: members, policy and published bots. */
function TeamPanel({ team, onClose }: { team: Team; onClose: () => void }) {
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"member" | "manager">("member");
  const [newPolicy, setNewPolicy] = useState<PolicyRule>({ action: "", effect: "ask", note: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await workforce.team(team.id);
    setDetail({ team: data.team, members: data.members, bots: data.bots, policy: (data.policy as PolicyRule[]) || [] });
    const activity = await workforce.teamActivity(team.id);
    setDetail((current) => (current ? { ...current, activity: activity.events } : current));
  }, [team.id]);

  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);

  const act = async (label: string, action: () => Promise<unknown>, then?: () => void) => { setBusy(label); setError(""); try { await action(); then?.(); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(""); void load().catch(() => undefined); } };

  if (!detail) return null;
  return (
    <section className={card} data-testid={`team-${team.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold text-slate-900 flex items-center gap-2"><Users size={16} /> {detail.team.name}</h2><p className="mt-1 text-xs text-slate-500">{detail.team.description}{` · `}{detail.team.memberCount} members · {detail.team.botCount} teammates</p></div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <span className={heading}>Members</span>
          <ul className="mt-1 space-y-1">
            {detail.members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-2 text-sm text-slate-700">
                <span className="flex items-center gap-2"><span className="pill-badge" data-status={member.role}>{member.role}</span>{member.email}{member.displayName ? ` — ${member.displayName}` : ""}</span>
                {member.role !== "owner" && <button type="button" onClick={() => void act("Removing", () => workforce.teamRemoveMember(detail.team.id, member.userId), () => setError("Member removed."))} disabled={busy !== ""} className={button}>Remove</button>}
              </li>
            ))}
            {!detail.members.length && <li className="text-xs text-slate-500">No members listed.</li>}
          </ul>
          <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (!memberEmail.trim()) return; void act("Adding", () => workforce.teamAddMember(detail.team.id, memberEmail.trim(), memberRole)); setMemberEmail(""); }}>
            <input value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="new member email" className={input} style={{ maxWidth: "220px" }} />
            <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "member" | "manager")} className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
              <option value="member">member</option><option value="manager">manager</option>
            </select>
            <button type="submit" className={primary}><Users size={13} /> Add member</button>
          </form>
        </div>

        <div>
          <span className={heading}>Published teammates</span>
          <ul className="mt-1 space-y-1">
            {detail.bots.map((bot) => {
              const published = bot.publishedAt !== null;
              const handler = () => (published ? workforce.teamUnpublishBot(detail.team.id, bot.id) : workforce.teamPublishBot(detail.team.id, bot.id));
              return (
                <li key={bot.id} className="flex items-center justify-between gap-2 text-sm text-slate-700" data-testid={`team-bot-${bot.id}`}>
                  <span className="flex items-center gap-2"><BotIcon size={14} className="text-slate-900" />{bot.name} · {bot.status}</span>
                  <button type="button" onClick={() => void act(published ? "Unpublishing" : "Publishing", () => handler(), () => setError(`Bot ${published ? "unpublished" : "published"}.`))} disabled={busy !== ""} className={button}><Lock size={12} /> {published ? "Unpublish" : "Publish"}</button>
                </li>
              );
            })}
            {!detail.bots.length && <li className="text-xs text-slate-500">Move teammates with visibility = team, then publish them.</li>}
          </ul>
        </div>

        <div>
          <span className={heading}>Organization policy</span>
          <p className="mt-1 text-xs text-slate-500">Rules can restrict what teammates may do even when someone allows it.</p>
          <ul className="mt-2 space-y-1">
            {detail.policy.map((rule, index) => (
              <li key={index} className={`rounded-lg border px-3 py-1.5 text-xs ${EFFECT_TONES[rule.effect] || ""}`} data-testid="team-policy-rule">{rule.action}{rule.note ? ` — ${rule.note}` : ""}</li>
            ))}
            {!detail.policy.length && <li className="text-xs text-slate-500">No policy rules yet — teammates run by their autonomy level.</li>}
          </ul>
          <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (!newPolicy.action.trim()) return; void act("Saving policy", () => workforce.teamSetPolicy(detail.team.id, [...detail.policy, { action: newPolicy.action.trim(), effect: newPolicy.effect, note: newPolicy.note }]), () => { setNewPolicy({ action: "", effect: "ask", note: "" }); }); }}>
            <input value={newPolicy.action} onChange={(event) => setNewPolicy({ ...newPolicy, action: event.target.value })} placeholder="action, e.g. team.publish or payments.*" className={input} style={{ maxWidth: "180px" }} />
            <select value={newPolicy.effect} onChange={(event) => setNewPolicy({ ...newPolicy, effect: event.target.value as "allow" | "ask" | "deny" })} className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" data-testid="team-policy-effect"><option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option></select>
            <button type="submit" className={primary} data-testid="team-policy-add"><PlusIcon size={13} /> Add rule</button>
          </form>
        </div>
      </div>

      <div className="mt-4">
        <span className={heading}>Activity</span>
        <ul className="mt-2 space-y-1">
          {(detail.activity || []).slice(0, 15).map((event) => <li key={event.id} className="text-xs text-slate-600">{event.kind}{event.severity ? ` (${event.severity})` : ""} · {formatTime(event.createdAt)}</li>)}
          {!(detail.activity || []).length && <li className="text-xs text-slate-500">No activity yet.</li>}
        </ul>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </section>
  );
}

function PlusIcon({ size }: { size: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }

export default function TeamCenterPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [detail, setDetail] = useState<Team | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => { setTeams((await workforce.teams()).teams); }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    const timer = setInterval(() => void workforce.teams().then((data) => setTeams(data.teams)).catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const create = async () => { setError(""); workforce.teamCreate(name.trim(), description).then((r) => { setTeams((current) => [r.team, ...current]); setName(""); setDescription(""); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work.")); };

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="team-center">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Team Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Publish your teammates to a team. Team bots are usable by the other teammates of the same team — nothing private is shared between teammates automatically.</p>
        </div>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Team name" className={input} style={{ maxWidth: "180px" }} data-testid="new-team-name" />
          <button type="submit" className={primary} disabled={!name.trim()} data-testid="new-team"><Zap size={16} /> New team</button>
        </form>
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Teams">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Teams</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {teams.length === 0 ? (
          <div className={card} data-testid="teams-empty"><p className="text-sm text-slate-500">No teams yet. Create one, add members and managers, then publish teammates to share with them.</p></div>
        ) : (
          <ul className="space-y-3" data-testid="teams-list">
            {teams.map((team) => (
              <li key={team.id} className={card} data-testid={`team-${team.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Users size={15} /> {team.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{team.description}{` · ${team.memberCount} members, ${team.botCount} teammates`}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{team.role}</span>
                      {team.botCount > 0 && <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{team.botCount} teammate{team.botCount === 1 ? "" : "s"}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setDetail(team)} className={button} data-testid={`team-open-${team.id}`}><Crown size={13} /> Open</button>

                    <button type="button" onClick={() => workforce.teamDelete(team.id).then(() => { setTeams((current) => current.filter((item) => item.id !== team.id)); setDetail(null); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className="btn-ghost text-rose-600"><Trash2 size={13} /> Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && <TeamPanel team={detail} onClose={() => setDetail(null)} />}
    </main>
  );
}
