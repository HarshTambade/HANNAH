import { useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../services/api";

const CACHE_KEY = "hannah.presence.v1";

type PresenceCache = { day: string; status: string; exposedAt: string };

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function PresenceFeed() {
  const [status, setStatus] = useState("");

  useEffect(() => {
    const currentDay = today();
    let cache: PresenceCache | null = null;
    try {
      cache = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null");
    } catch {
      cache = null;
    }

    if (cache?.day === currentDay) {
      setStatus(cache.status);
      return;
    }

    let active = true;
    void apiFetch(apiUrl("/api/presence"))
      .then((response) => response.json())
      .then((data) => {
        if (!active || typeof data?.status !== "string") return;
        const nextCache: PresenceCache = { day: currentDay, status: data.status, exposedAt: new Date().toISOString() };
        setStatus(data.status);
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(nextCache));
        } catch {
          // Best effort.
        }
      })
      .catch(() => {
        if (active) setStatus("HANNAH is ready when you are.");
      });

    return () => {
      active = false;
    };
  }, []);

  if (!status) return null;

  return (
    <div className="mx-4 mb-3 rounded-2xl border border-violet-200/10 bg-violet-200/[0.04] px-4 py-2 text-[10px] leading-5 text-violet-100/80">
      {status}
    </div>
  );
}