import { useEffect, useRef, useState } from "react";

export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [supported] = useState(() => typeof (window as any).BarcodeDetector !== "undefined");

  useEffect(() => {
    if (!supported) { setError("This browser can't scan QR codes. Type the code instead."); return; }
    let stream: MediaStream | null = null;
    let cancelled = false;
    const Detector = (window as any).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) return;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length) { onResult(String(codes[0].rawValue || "")); return; }
          } catch { /* ignore */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Camera couldn't be opened."); }
    })();
    return () => { cancelled = true; stream?.getTracks().forEach((track) => track.stop()); };
  }, [supported, onResult]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Scan a QR code</h2>
          <button type="button" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm" onClick={onClose}>Close</button>
        </div>
        {error && <p className="mt-2 text-sm text-rose-800" role="alert">{error}</p>}
        {!error && <video ref={videoRef} className="mt-3 w-full rounded-lg bg-black" playsInline muted />}
        <p className="mt-2 text-xs text-slate-600">Point the camera at a QR code. If scanning isn't supported, type the code by hand.</p>
      </div>
    </div>
  );
}
