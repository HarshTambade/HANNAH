import { describe, expect, it } from "vitest";
import { createTeleopSender, velocityFromGamepad, velocityFromKeys, velocityFromPad } from "../services/RobotOps";

const limits = { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5 };
const pressed = (indexes: number[]) => Array.from({ length: 8 }, (_, index) => ({ pressed: indexes.includes(index) }));

describe("manual-control input", () => {
  it("maps keys, the on-screen pad and a gamepad to speeds within the limits", () => {
    expect(velocityFromKeys(new Set(["ArrowUp"]), limits)).toEqual({ linear: 0.25, angular: 0 });
    expect(velocityFromKeys(new Set(["s", "d"]), limits)).toEqual({ linear: -0.25, angular: -0.75 });
    expect(velocityFromKeys(new Set(), limits)).toEqual({ linear: 0, angular: 0 });
    expect(velocityFromPad(0, 2, limits)).toEqual({ linear: 0.5, angular: 0 });
    expect(velocityFromPad(1, 0, limits)).toEqual({ linear: 0, angular: -1.5 });
    // No deadman, no motion; inside the dead zone, centred.
    expect(velocityFromGamepad([0, -1], pressed([]), limits)).toEqual({ deadman: false, velocity: { linear: 0, angular: 0 } });
    expect(velocityFromGamepad([0.1, -1], pressed([4]), limits)).toEqual({ deadman: true, velocity: { linear: 0.5, angular: 0 } });
    expect(velocityFromGamepad([-1, 0], pressed([0]), limits).velocity.angular).toBe(1.5);
  });

  it("sends only while the deadman is held, one zero command on release, numbers that only go up, and never queues", async () => {
    const sent: Array<{ seq: number; linear: number; angular: number }> = [];
    let release: () => void = () => {};
    const sender = createTeleopSender(async (command) => { sent.push(command); }, () => 1000);
    expect(await sender.tick(false, { linear: 0.3, angular: 0 })).toBeNull();
    await sender.tick(true, { linear: 0.3, angular: 0 });
    await sender.tick(true, { linear: 0.2, angular: 0.1 });
    await sender.tick(false, { linear: 0.2, angular: 0.1 });
    expect(await sender.tick(false, { linear: 0.2, angular: 0.1 })).toBeNull();
    expect(sent.map((command) => [command.linear, command.angular])).toEqual([[0.3, 0], [0.2, 0.1], [0, 0]]);
    expect(sent[1].seq).toBeGreaterThan(sent[0].seq);
    expect(sent[2].seq).toBeGreaterThan(sent[1].seq);

    const slow = createTeleopSender(() => new Promise<void>((done) => { release = done; }));
    const first = slow.tick(true, { linear: 0.1, angular: 0 });
    expect(await slow.tick(true, { linear: 0.1, angular: 0 })).toBeNull();
    release();
    await first;
    expect(slow.stats.sent).toBe(1);
  });
});
