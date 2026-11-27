import { describe, expect, it } from "vitest";
import { pickAudioType, startLiveRecorder, type RecorderDeps } from "../services/LiveMeetingRecorder";

function fakes(upload: RecorderDeps["upload"]) {
  const timers: Array<() => void> = [];
  const recorders: Array<{ state: string; mimeType: string; ondataavailable: ((event: { data: Blob }) => void) | null; onstop: ((event: Event) => void) | null; start: () => void; stop: () => void }> = [];
  let clock = 1_000;
  let stopped = 0;
  const deps: RecorderDeps = {
    getStream: async () => ({ getTracks: () => [{ stop: () => { stopped += 1; } }] }) as unknown as MediaStream,
    createRecorder: () => {
      const recorder = {
        state: "inactive", mimeType: "audio/webm", ondataavailable: null as ((event: { data: Blob }) => void) | null, onstop: null as ((event: Event) => void) | null,
        start() { this.state = "recording"; },
        stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob([`piece-${recorders.indexOf(this)}`], { type: "audio/webm" }) }); this.onstop?.(new Event("stop")); },
      };
      recorders.push(recorder);
      return recorder as never;
    },
    upload,
    onText: (line) => lines.push(line),
    onProblem: (message, fatal) => problems.push({ message, fatal }),
    now: () => clock,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => undefined,
    wait: async () => undefined,
  };
  const lines: string[] = [];
  const problems: Array<{ message: string; fatal: boolean }> = [];
  const elapse = (ms: number) => { clock += ms; const next = timers.shift(); next?.(); };
  return { deps, lines, problems, recorders, elapse, stoppedTracks: () => stopped };
}

describe("live meeting recorder", () => {
  it("records complete pieces in order, uploads them one by one with their offset, and sends the last piece on stop", async () => {
    const sent: Array<[number, number, string]> = [];
    const f = fakes(async (seq, at, piece) => { sent.push([seq, at, await piece.text()]); return { text: `[${seq}] words` }; });
    const recorder = startLiveRecorder({ ...f.deps, firstSeq: 0, pieceMs: 20_000 });
    expect(await recorder.ready).toBe(true);
    f.elapse(20_000);
    f.elapse(20_000);
    await recorder.stop();
    expect(sent).toEqual([[0, 0, "piece-0"], [1, 20_000, "piece-1"], [2, 40_000, "piece-2"]]);
    expect(f.lines).toEqual(["[0] words", "[1] words", "[2] words"]);
    expect(f.recorders).toHaveLength(3);
    expect(f.stoppedTracks()).toBe(1);
  });

  it("retries a piece after a passing failure, and stops for good when the server refuses", async () => {
    let calls = 0;
    const f = fakes(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Groq's rate limit was reached."), { status: 429 });
      if (calls === 3) throw Object.assign(new Error("Live notes aren't running for this meeting."), { status: 409 });
      return { text: "ok" };
    });
    const recorder = startLiveRecorder({ ...f.deps, pieceMs: 20_000 });
    await recorder.ready;
    f.elapse(20_000);
    f.elapse(20_000);
    await recorder.stop();
    expect(f.lines).toEqual(["ok"]);
    expect(f.problems).toEqual([{ message: "Live notes aren't running for this meeting.", fatal: true }]);
  });

  it("continues numbering from where a meeting left off, and says when the microphone is refused", async () => {
    const seqs: number[] = [];
    const f = fakes(async (seq) => { seqs.push(seq); return { text: "" }; });
    const recorder = startLiveRecorder({ ...f.deps, firstSeq: 7 });
    await recorder.ready;
    await recorder.stop();
    expect(seqs).toEqual([7]);
    const denied = fakes(async () => ({ text: "" }));
    denied.deps.getStream = async () => { throw new Error("Permission denied"); };
    expect(await startLiveRecorder(denied.deps).ready).toBe(false);
    expect(denied.problems[0]).toEqual({ message: "Microphone access was refused. Allow it in the browser to take live notes.", fatal: true });
  });

  it("picks an audio format the browser can record", () => {
    expect(pickAudioType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickAudioType(() => false)).toBe("");
  });
});
