import { useState, useEffect } from "react";
import { User, MapPin, Briefcase, Calendar, Trash2, Search } from "lucide-react";
import { PersonalKnowledgeGraph, type Entity, type Relationship } from "../services/PersonalKnowledgeGraph";

export default function DigitalTwinPanel() {
  const [entities, setEntities] = useState<Entity[]>(() => PersonalKnowledgeGraph.getEntities());
  const [relationships, setRelationships] = useState<Relationship[]>(() => PersonalKnowledgeGraph.getRelationships());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ entities: Entity[]; relationships: Relationship[]; query: string; path: string[] } | null>(null);

  useEffect(() => {
    const refresh = () => {
      setEntities(PersonalKnowledgeGraph.getEntities());
      setRelationships(PersonalKnowledgeGraph.getRelationships());
    };
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const handleQuery = () => {
    const result = PersonalKnowledgeGraph.query(query);
    setResults(result);
  };

  const handleDelete = (id: string) => {
    PersonalKnowledgeGraph.removeEntity(id);
    setEntities(PersonalKnowledgeGraph.getEntities());
    setRelationships(PersonalKnowledgeGraph.getRelationships());
  };

  const typeIcons: Record<string, React.ReactNode> = {
    person: <User size={14} />,
    place: <MapPin size={14} />,
    project: <Briefcase size={14} />,
    event: <Calendar size={14} />,
  };

  const grouped = entities.reduce<Record<string, Entity[]>>((acc, e) => {
    if (!acc[e.type]) acc[e.type] = [];
    acc[e.type].push(e);
    return acc;
  }, {});

  return (
    <div className="bento-card glass-card-strong">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Digital Twin</h3>
          <div className="text-[10px] text-slate-500 mt-1">Personal knowledge graph · {entities.length} entities · {relationships.length} relationships</div>
        </div>
        <div className="flex items-center gap-2">
          <Search size={14} className="text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleQuery(); }}
            placeholder="Query graph..."
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-ink outline-none focus:border-brand-400/60 w-40"
          />
        </div>
      </div>

      {results && (
        <div className="mb-4 rounded-xl border border-brand-100 bg-brand-50 p-3">
          <div className="text-[10px] font-bold text-brand-600 mb-1">Query: "{results.query}"</div>
          <div className="text-[10px] text-slate-600">
            Found {results.entities.length} entities, {results.relationships.length} relationships
          </div>
          {results.path.length > 0 && (
            <div className="text-[9px] text-slate-500 mt-1">Path: {results.path.join(" → ")}</div>
          )}
        </div>
      )}

      <div className="space-y-4">
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type}>
            <h4 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 mb-2 flex items-center gap-1.5">
              {typeIcons[type] || <User size={14} />}
              {type}s ({items.length})
            </h4>
            <div className="space-y-1">
              {items.map((entity) => (
                <div key={entity.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{entity.name}</span>
                    <span className="text-[9px] text-slate-400">{entity.type}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(entity.id)}
                    className="text-[9px] text-rose-500 hover:text-rose-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 rounded p-0.5"
                    aria-label={`Delete ${entity.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {entities.length === 0 && (
        <div className="text-center py-8 text-[11px] text-slate-500">
          No entities extracted yet. Start chatting to build your personal knowledge graph.
        </div>
      )}
    </div>
  );
}
