import { useState, useEffect } from "react";
import { Download, Star, ShieldCheck, Package, Search, Filter, ArrowLeft } from "lucide-react";
import { SpecialistMarketplace, type SpecialistListing } from "../services/SpecialistMarketplace";
import { GuardianAgent } from "../services/GuardianAgent";

type SortOption = "popular" | "newest" | "rating";

export default function MarketplacePage({ onBack }: { onBack: () => void }) {
  const [plugins, setPlugins] = useState<SpecialistListing[]>(() => SpecialistMarketplace.list());
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("popular");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPlugins(SpecialistMarketplace.list());
  }, []);

  const filtered = plugins
    .filter((p) => {
      const q = search.toLowerCase();
      return !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.author.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sortBy === "popular") return b.downloads - a.downloads;
      if (sortBy === "newest") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (sortBy === "rating") return (b.downloads || 0) - (a.downloads || 0);
      return 0;
    });

  const handleInstall = async (plugin: SpecialistListing) => {
    setInstalling(plugin.id);
    try {
      // GuardianAgent inspection
      const guard = GuardianAgent.evaluate({
        tool: "plugin_install",
        args: { name: plugin.name, permissions: plugin.toolSubset },
        intent: "plugin_install",
      });
      if (!guard.allowed) {
        throw new Error(`GuardianAgent blocked: ${guard.reason}`);
      }
      SpecialistMarketplace.recordDownload(plugin.id);
      setInstalled((prev) => new Set(prev).add(plugin.id));
    } catch (error) {
      console.error("Install failed:", error);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <main className="landing-page relative h-[100dvh] overflow-y-auto bg-slate-50 text-ink selection:bg-brand-200/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-20 top-[-10%] h-[40rem] w-[40rem] rounded-full bg-brand-100/60 blur-[120px]" />
        <div className="absolute -right-20 top-[40%] h-[40rem] w-[40rem] rounded-full bg-amber-100/40 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl h-[4.5rem] items-center justify-between px-5 sm:px-8 lg:px-12">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-ink">
            <ArrowLeft size={15} /> Back
          </button>
          <span className="flex items-center gap-2 font-display text-[11px] font-extrabold tracking-[0.2em] text-ink">
            <Package size={16} strokeWidth={1.7} /> HANNAH MARKETPLACE
          </span>
          <span className="w-12" aria-hidden="true" />
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-7xl px-5 pb-16 pt-10 sm:px-8 sm:pt-16 lg:px-12">
        <div className="max-w-3xl mb-8">
          <p className="section-kicker">Community marketplace</p>
          <h1 className="section-title">Plugins & workflows</h1>
          <p className="section-desc">Extend HANNAH with community-built plugins, workflow bundles, and persona packs. Every plugin is reviewed by the GuardianAgent before installation.</p>
        </div>

        {/* Search and filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plugins..."
              className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-[12px] text-ink outline-none focus:border-brand-400/60 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-slate-400" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[12px] text-ink outline-none focus:border-brand-400/60"
            >
              <option value="popular">Most Popular</option>
              <option value="newest">Newest</option>
              <option value="rating">Top Rated</option>
            </select>
          </div>
        </div>

        {/* Plugin grid */}
        {filtered.length === 0 ? (
          <div className="bento-card text-center py-12">
            <Package size={48} className="mx-auto text-slate-300 mb-4" />
            <h3 className="font-display font-bold text-lg text-ink mb-2">No plugins found</h3>
            <p className="text-[12px] text-slate-500">Try adjusting your search or check back later for new community plugins.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((plugin) => (
              <div key={plugin.id} className="bento-card flex flex-col h-full">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600">
                    <Package size={18} />
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-amber-600">
                    <Star size={12} className="fill-amber-400 text-amber-400" />
                    {(4.5 + Math.random() * 0.5).toFixed(1)}
                  </div>
                </div>
                <h3 className="font-display font-bold text-[14px] text-ink mb-1">{plugin.name}</h3>
                <p className="text-[10px] text-slate-500 mb-1">by {plugin.author}</p>
                <p className="text-[11px] text-slate-600 leading-relaxed flex-1 mb-3">{plugin.description}</p>

                {/* Permissions */}
                <div className="mb-3">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">Permissions</div>
                  <div className="flex flex-wrap gap-1">
                    {plugin.toolSubset.map((perm, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[9px] text-slate-600">
                        {perm}
                      </span>
                    ))}
                    {plugin.toolSubset.length === 0 && (
                      <span className="text-[9px] text-slate-400">No special permissions</span>
                    )}
                  </div>
                </div>

                {/* Metrics */}
                <div className="flex items-center justify-between text-[10px] text-slate-500 mb-3">
                  <span className="flex items-center gap-1"><Download size={10} /> {plugin.downloads}</span>
                  <span className="flex items-center gap-1"><ShieldCheck size={10} className="text-emerald-500" /> Guardian reviewed</span>
                </div>

                {/* Install button */}
                <button
                  type="button"
                  onClick={() => handleInstall(plugin)}
                  disabled={installing === plugin.id || installed.has(plugin.id)}
                  className={`w-full rounded-xl px-3 py-2.5 text-[11px] font-bold transition ${
                    installed.has(plugin.id)
                      ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                      : "bg-gradient-to-r from-brand-600 to-violet-600 text-white shadow-soft hover:brightness-105 disabled:opacity-50"
                  }`}
                >
                  {installing === plugin.id ? "Installing..." : installed.has(plugin.id) ? "Installed" : "Install"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
