import {
  PieChart, Pie, ResponsiveContainer, Cell,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

export function FocusAreaDistribution() {
  const data = [
    { name: "Automation & Workflows", value: 30, color: "#8B5CF6" },
    { name: "Empathic Chat", value: 25, color: "#3B82F6" },
    { name: "Code Execution", value: 25, color: "#FDBA74" },
    { name: "System Control", value: 20, color: "#10B981" },
  ];

  return (
    <div className="bento-card span-1-2 flex flex-col h-full">
      <div className="mb-6">
        <div className="bento-kicker">Focus Area Distribution</div>
        <div className="bento-title">How Shanaya spends her time</div>
        <div className="bento-desc">Task breakdown across all completed sessions in the past 30 days.</div>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              fill="#8884d8"
              labelLine={false}
              label={({ name, percent }: any) => (
                <text
                  x={0}
                  y={4}
                  dy=".35em"
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize={11}
                  fontWeight={600}
                >
                  {`${name} ${Math.round(percent * 100)}%`}
                </text>
              )}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Legend verticalAlign="top" align="center" height={36} formatter={(value: string) => value} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {data.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
            <span className="text-[11px] font-medium text-slate-600">{item.name}</span>
            <span className="ml-auto text-[11px] font-bold text-ink">{item.value}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ResolvedTasks() {
  return (
    <div className="bento-card span-1-1 flex flex-col h-full">
      <div className="mb-4">
        <div className="bento-kicker">Resolved Tasks</div>
        <div className="bento-title">14.2K</div>
        <div className="bento-desc">Tasks executed in the past 7 days.</div>
      </div>
      <div className="mt-6 flex-1 flex items-end justify-center relative h-48">
        <svg className="w-full h-full" viewBox="0 0 120 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id="sparkGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#FDBA74" />
            </linearGradient>
          </defs>
          <path d="M10,90 Q30,50 50,80 T90,60" stroke="url(#sparkGrad)" strokeWidth="3" fill="none" strokeLinecap="round" />
          {[10, 30, 50, 70, 90].map((x) => (
            <circle key={x} cx={x} cy={x === 10 ? 90 : x === 30 ? 50 : x === 50 ? 80 : x === 70 ? 60 : 60} r="2.5" fill="#8B5CF6" />
          ))}
        </svg>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="text-center">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Success Rate</div>
          <div className="font-display font-bold text-lg text-ink">99.4%</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Avg. Latency</div>
          <div className="font-display font-bold text-lg text-ink">140ms</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Errors</div>
          <div className="font-display font-bold text-lg text-ink">0</div>
        </div>
      </div>
    </div>
  );
}

export function MemoryUtilization() {
  return (
    <div className="bento-card span-1-1 flex flex-col h-full">
      <div className="mb-4">
        <div className="bento-kicker">Memory Consolidation</div>
        <div className="bento-title">68%</div>
        <div className="bento-desc">Long-term memory capacity used.</div>
      </div>
      <div className="mt-6 flex flex-col items-center justify-center relative h-56 w-56 mx-auto">
        <svg className="w-full h-full" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" stroke="#e2e8f0" strokeWidth="8" fill="none" />
          <circle
            cx="50"
            cy="50"
            r="42"
            stroke="url(#memGrad)"
            strokeWidth="8"
            fill="none"
            strokeDasharray="264"
            strokeDashoffset={84}
            className="transition-all duration-1000 ease-out"
          />
          <defs>
            <linearGradient id="memGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#10B981" />
              <stop offset="100%" stopColor="#3B82F6" />
            </linearGradient>
          </defs>
          <text x="50" y="55" fontFamily="Manrope" fontSize="24" fontWeight="800" fill="#0f172a" textAnchor="middle">68%</text>
        </svg>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-white/50 bg-white/40 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-[11px] font-medium text-slate-600">Episodic</span>
          </div>
          <div className="mt-1 text-[11px] font-bold text-ink">1,204 items</div>
        </div>
        <div className="rounded-xl border border-white/50 bg-white/40 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="text-[11px] font-medium text-slate-600">Persona</span>
          </div>
          <div className="mt-1 text-[11px] font-bold text-ink">87 anchors</div>
        </div>
      </div>
    </div>
  );
}

export function TokenCostEfficiency() {
  const data = [
    { name: "Mon", local: 65, cloud: 35 },
    { name: "Tue", local: 72, cloud: 28 },
    { name: "Wed", local: 68, cloud: 32 },
    { name: "Thu", local: 75, cloud: 25 },
    { name: "Fri", local: 70, cloud: 30 },
    { name: "Sat", local: 82, cloud: 18 },
    { name: "Sun", local: 88, cloud: 12 },
  ];

  return (
    <div className="bento-card span-1-1 flex flex-col h-full">
      <div className="mb-4">
        <div className="bento-kicker">Token & Cost Efficiency</div>
        <div className="bento-title">$14.20 saved</div>
        <div className="bento-desc">Local routing reduced cloud token spend this week.</div>
      </div>
      <div className="mt-4 flex-1">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} barCategoryGap={8}>
            <defs>
              <linearGradient id="barGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#8B5CF6" />
                <stop offset="100%" stopColor="#10B981" />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} horizontal={false} />
            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#64748b" }} />
            <YAxis axisLine={false} tickLine={false} hide />
            <Tooltip
              content={({ active, payload }: any) => {
                if (active && payload && payload.length) {
                  return (
                    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-soft">
                      <div className="text-[11px] text-slate-500 font-medium">{payload[0].name}</div>
                      <div className="mt-1 text-sm font-bold text-ink">Local: {payload[0].value.local}%</div>
                    </div>
                  );
                }
                return null;
              }}
            />
            <Legend verticalAlign="top" align="right" height={24} />
            <Bar dataKey="local" fill="url(#barGrad)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="text-center">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Local Routing</div>
          <div className="font-display font-bold text-lg text-ink">70%</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Cloud Routing</div>
          <div className="font-display font-bold text-lg text-ink">30%</div>
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsCards() {
  return (
    <div className="grid gap-4">
      <FocusAreaDistribution />
      <ResolvedTasks />
      <MemoryUtilization />
      <TokenCostEfficiency />
    </div>
  );
}
