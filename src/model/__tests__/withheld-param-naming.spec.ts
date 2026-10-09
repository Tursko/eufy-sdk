import { describe, it, expect } from "vitest";
import { Device, UNKNOWN_PARAM_PREFIX } from "../index.js";
import type { CloudRecord } from "../index.js";

/**
 * A read a device's own gate withheld, and the other door it used to answer.
 *
 * The param dictionary names ids for a whole namespace, and a capability names the same ids for the
 * devices that carry the read — so both name 1101 `battery`, and they disagree only about which device it
 * describes. A mains camera reports 1101 as a sentinel and `notMainsCamera` withholds the typed read; the
 * dictionary then published the same value under the same name, so a caller could not tell it from a
 * charge a device really answered.
 *
 * A capability that never resolved withholds nothing, and its params keep their dictionary name: a
 * reading that arrives before its capability is still the device's own, and a later record widens onto it.
 */
describe("a read withheld by a resolved capability's own gate", () => {
  it("keeps a late signal unnamed until its camera read has reported evidence", () => {
    const dev = Device.fromRecord("T8114P0000000000", { deviceType: 9, model: "T8114", params: { 1035: "0" } });
    const changed = dev.applyParams({ 1142: "-71" });
    expect(changed).toEqual([`${UNKNOWN_PARAM_PREFIX}1142`]);
    expect(dev.getProperty("wifiRssi")).toBeUndefined();
    expect(dev.getProperty(`${UNKNOWN_PARAM_PREFIX}1142`)?.value).toBe("-71");
    expect(dev.announcements(changed)).toEqual([]);
  });

  /** A mains camera: reports 1101 as a sentinel, which is what makes `battery` resolve at all. */
  const mains: CloudRecord = { deviceType: 9, model: "T8425P0000000000", params: { 1101: "100" } };
  /** A battery camera on the same params. */
  const cell: CloudRecord = { deviceType: 9, model: "T8114P0000000000", params: { 1101: "88" } };

  it("takes the passthrough rather than the dictionary name the gate refused", () => {
    const dev = Device.fromRecord("T8425P0000000000", mains);

    expect(dev.capabilities).toContain("battery");
    expect(dev.getProperty("battery")).toBeUndefined();
    expect(dev.getProperty(`${UNKNOWN_PARAM_PREFIX}1101`)?.value).toBe("100");
    expect(dev.battery?.()?.level).toBeUndefined();
  });

  it("answers the same read on a device whose gate allows it", () => {
    const dev = Device.fromRecord("T8114P0000000000", cell);

    expect(dev.getProperty("battery")?.value).toBe(88);
    expect(dev.getProperty(`${UNKNOWN_PARAM_PREFIX}1101`)).toBeUndefined();
  });

  it("keeps the dictionary name where no resolved capability claims the param", () => {
    const dev = Device.fromRecord("T8114P0000000000", cell);

    // 1019 is `enableHdr` in the security dictionary and no capability claims it: nothing decided
    // against it, so the loose read still answers.
    expect(dev.applyParams({ 1019: "1" })).toEqual(["enableHdr"]);
  });

  it("withholds a previously reported cell read when the model gate changes", () => {
    const dev = Device.fromRecord("T8114P0000000000", cell);
    expect(dev.properties.some((p) => p.name === "battery")).toBe(true);

    dev.reresolve({ ...mains, params: {} });
    dev.bindActions(
      { channel: 0, codec: "camera", deviceType: 9, model: mains.model, paramIds: new Set([1101]) },
      { dispatch: async () => undefined },
    );

    expect(dev.capabilities).toContain("battery");
    expect(dev.properties.some((p) => p.name === "battery")).toBe(false);
    expect(dev.battery?.()?.level).toBeUndefined();
    expect(dev.applyParams({ 1101: "100" })).toEqual([`${UNKNOWN_PARAM_PREFIX}1101`]);
    expect(dev.announcements(["battery", `${UNKNOWN_PARAM_PREFIX}1101`])).toEqual([]);
  });

  it("withholds a retained camera audio read after authoritative device-type reclassification", () => {
    const dev = Device.fromRecord("T8000P0000000000", {
      deviceType: 9,
      category: "eufy_security",
      params: { 1240: "1" },
    });
    expect(dev.properties.some((p) => p.name === "microphone")).toBe(true);

    dev.reresolve({ deviceType: 0, category: "eufy_security", params: {} });
    dev.bindActions(
      { channel: 0, codec: "station", deviceType: 0, paramIds: new Set([1240]) },
      { dispatch: async () => undefined },
    );

    expect(dev.codec).toBe("station");
    expect(dev.capabilities).toContain("audio");
    expect(dev.properties.some((p) => p.name === "microphone")).toBe(false);
    expect(dev.audio?.()?.microphone).toBeUndefined();
    expect(dev.applyParams({ 1240: "0" })).toEqual([`${UNKNOWN_PARAM_PREFIX}1240`]);
  });

  it("does not carry a retained camera audio read into the clean namespace", () => {
    const dev = Device.fromRecord("T8000P0000000000", { deviceType: 9, params: { 1240: "1" } });

    dev.reresolve({ model: "T2351", category: "eufy_home", params: {} });
    dev.bindActions(
      { channel: 0, codec: "vacuum", model: "T2351", category: "eufy_home", paramIds: new Set([1240]) },
      { dispatch: async () => undefined },
    );

    expect(dev.codec).toBe("vacuum");
    expect(dev.capabilities).not.toContain("audio");
    expect(dev.properties.some((p) => p.name === "microphone")).toBe(false);
    expect(dev.audio?.()?.microphone).toBeUndefined();
    expect(dev.announcements(dev.applyParams({ 1240: "0" }))).toEqual([]);
  });

  it("respects stated attachment and detachment while an omitted parent remains silent", () => {
    const record = { model: "T8170", category: "eufy_security", params: {} };
    const dev = Device.fromRecord("T8000P0000000000", record);
    dev.bindActions(
      { codec: "camera", model: "T8170", category: "eufy_security", channel: 0, paramIds: new Set() },
      { dispatch: async () => undefined },
    );
    expect(dev.has("arming")).toBe(true);
    dev.reresolve({ ...record, parentSn: "T9000P0000000000" });
    expect(dev.has("arming")).toBe(false);
    expect(dev.arming?.()).toBeUndefined();
    dev.reresolve(record);
    expect(dev.has("arming")).toBe(false);
    expect(dev.stationSn).toBe("T9000P0000000000");
    dev.reresolve({ ...record, parentSn: "" });
    expect(dev.has("arming")).toBe(true);
    expect(dev.stationSn).toBe(dev.sn);
  });

  it("keeps effective category and classification when a later binding context omits them", () => {
    const dev = Device.fromRecord("T8000P0000000000", {
      model: "T2118",
      category: "eufy_home_tuya",
      params: { 104: "41" },
    });
    dev.bindActions(
      { codec: "vacuum", model: "T2118", category: "eufy_home_tuya", channel: 0, paramIds: new Set([104]) },
      { dispatch: async () => undefined },
    );
    dev.reresolve({ params: {} });
    dev.bindActions({ codec: "camera", channel: 0, paramIds: new Set() }, { dispatch: async () => undefined });
    expect(dev.codec).toBe("vacuum");
    expect(dev.vacuumClean?.()?.battery).toBe(41);
    expect(dev.vacuumClean?.()).not.toHaveProperty("setPower");
  });
});
