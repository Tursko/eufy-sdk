import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Device } from "../device.js";
import type { CloudRecord, ResolvedDevice } from "../types.js";
import { VACUUM_DP } from "../capabilities/vacuum-clean.js";

/** A bare battery-camera resolution — one known param (`battery`, 1101) is enough for these reads. */
const RESOLVED: ResolvedDevice = {
  codec: "camera",
  capabilities: ["battery"],
  properties: [{ name: "battery", paramType: 1101, type: "number", writable: false }],
  name: "cam",
  source: "model",
};

function makeDevice() {
  return new Device("T8000P0000000000", RESOLVED);
}

describe("Device read-through freshness cache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("without a policy, reads never trigger a refresh (default off)", () => {
    const dev = makeDevice();
    dev.applyParams({ 1101: "50" }, Date.now() - 60_000);
    expect(dev.getProperty("battery")?.value).toBe(50);
  });

  it("a fresh value is served from cache — no refresh scheduled", async () => {
    const dev = makeDevice();
    const refresh = vi.fn().mockResolvedValue(undefined);
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now());
    dev.getProperty("battery");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a stale read schedules exactly one coalesced background refresh", async () => {
    const dev = makeDevice();
    let resolveRefresh!: () => void;
    const refresh = vi.fn(() => new Promise<void>((r) => (resolveRefresh = r)));
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now() - 20_000);
    dev.getProperty("battery");
    dev.getProperty("battery");
    dev.getProperty("battery");
    expect(refresh).toHaveBeenCalledOnce();
    resolveRefresh();
  });

  it("a refresh that lands via applyParams makes subsequent reads fresh again", async () => {
    const dev = makeDevice();
    const refresh = vi.fn(async () => {
      dev.applyParams({ 1101: "60" }, Date.now());
    });
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    dev.applyParams({ 1101: "50" }, Date.now() - 20_000);
    dev.getProperty("battery");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(dev.getProperty("battery")?.value).toBe(60);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("an absent value never triggers a refresh (avoids hammering on a property the device lacks)", async () => {
    const dev = makeDevice();
    const refresh = vi.fn().mockResolvedValue(undefined);
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });
    expect(dev.getProperty("battery")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps a reported schema read through a partial record and updates it when reported again", () => {
    const record: CloudRecord = {
      model: "T2351",
      category: "eufy_home",
      params: { [VACUUM_DP.RESUME_CLEAN]: "0" },
    };
    const dev = Device.fromRecord("T2351P0000000000", record);
    const initial = dev.getProperty("resumeClean");
    expect(initial?.value).toBe(false);
    expect(dev.properties.some((p) => p.name === "resumeClean")).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(dev.reresolve({ ...record, params: {} })).toEqual([]);
    expect(dev.properties.some((p) => p.name === "resumeClean")).toBe(true);
    expect(dev.getProperty("resumeClean")).toEqual(initial);
    dev.bindActions(
      {
        codec: "vacuum",
        model: "T2351",
        category: "eufy_home",
        channel: 0,
        paramIds: new Set(),
        capabilities: new Set(),
      },
      { dispatch: async () => undefined },
    );
    expect(dev.vacuumClean?.()?.resumeClean).toBe(false);

    const report = { [VACUUM_DP.RESUME_CLEAN]: "1" };
    expect(dev.reresolve({ ...record, params: report })).toEqual([]);
    expect(dev.announcements(dev.applyParams(report))).toEqual([{ property: "resumeClean", value: true }]);
    expect(dev.getProperty("resumeClean")?.ts).toBe(Date.now());
    expect(dev.applyParams(report)).toEqual([]);
  });

  it("does not invent reported evidence or a cached value from an omitted field", () => {
    const record: CloudRecord = { model: "T2351", category: "eufy_home", params: {} };
    const dev = Device.fromRecord("T2351P0000000000", record);

    expect(dev.reresolve(record)).toEqual([]);
    expect(dev.properties.some((p) => p.name === "resumeClean")).toBe(false);
    expect(dev.getProperty("resumeClean")).toBeUndefined();
  });

  it("retains an existing matching product catalog on omission but drops it on reclassification", () => {
    const dev = Device.fromRecord("T8000P0000000000", {
      model: "T2351",
      category: "eufy_home",
      params: { 158: "1" },
    });
    const sink = { dispatch: async () => undefined };
    dev.bindActions(
      {
        codec: "vacuum",
        model: "T2351",
        category: "eufy_home",
        channel: 0,
        paramIds: new Set([158]),
        dpCatalog: { enumRanges: new Map([[158, [0, 1, 2]]]) },
      },
      sink,
    );
    expect(dev.suction?.()?.supportedLevels).toEqual([0, 1, 2]);
    dev.reresolve({ params: {} });
    dev.bindActions({ codec: "camera", channel: 0, paramIds: new Set() }, sink);
    expect(dev.suction?.()?.supportedLevels).toEqual([0, 1, 2]);
    dev.reresolve({ model: "T2118", category: "eufy_home_tuya", params: {} });
    dev.bindActions(
      { codec: "vacuum", model: "T2118", category: "eufy_home_tuya", channel: 0, paramIds: new Set() },
      sink,
    );
    expect(dev.suction?.()?.supportedLevels).toBeUndefined();
  });

  it("keeps a finite zero through partial records without making the cache fresh", async () => {
    const record: CloudRecord = { model: "T8114", deviceType: 9, params: { 1101: "0" } };
    const dev = Device.fromRecord("T8114P0000000000", record);
    const initial = dev.getProperty("battery");
    const refresh = vi.fn().mockResolvedValue(undefined);
    dev.setFreshnessPolicy({ staleAfterMs: 15_000, refresh });

    vi.advanceTimersByTime(20_000);
    dev.reresolve({ ...record, params: {} });
    expect(refresh).not.toHaveBeenCalled();
    expect(dev.getProperty("battery")).toEqual(initial);
    expect(dev.getProperty("battery")?.value).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
  });
});
