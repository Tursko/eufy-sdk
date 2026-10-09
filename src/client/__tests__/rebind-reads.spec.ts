import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { DeviceRegistry, type DeviceRecord } from "../device-registry.js";
import type { Device } from "../../model/device.js";
import type { CommandSink } from "../../core/contracts.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import type { MegaHttpClient } from "../../transport/http/mega-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function rebind(eufy: EufyMega): Promise<void> {
  return (eufy as never as { rebindReads: (sn: string) => Promise<void> }).rebindReads("VAC");
}

/**
 * Re-binding a device's reads after a realtime report widened the evidence.
 *
 * A robot's state exists only on its realtime feed, so the first report is what makes its typed reads
 * exist at all. That makes this path load-bearing — and it is reached from a fire-and-forget call on a
 * message handler, which is what these specs pin: one report must cost one cloud round-trip however many
 * capabilities decoded it, a failure must not turn every later report into another attempt, and the host
 * must learn the reads arrived.
 */
function withDevice(logger?: { warn: (m: string) => void }) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", logger: logger as never });
  // A `Device` stand-in over the three methods this path calls. The announcement half has its own spec
  // (`realtime-property-changes.spec.ts`); here it answers nothing so only the re-bind is observable.
  const dev = {
    bindActions: vi.fn(),
    applyParams: vi.fn(),
    announcements: vi.fn(() => []),
    reresolve: vi.fn(() => []),
  };
  (eufy as never as { liveDevices: Map<string, WeakRef<object>> }).liveDevices.set("VAC", new WeakRef(dev));
  (eufy as never as { boundParamIds: Map<string, ReadonlySet<number>> }).boundParamIds.set("VAC", new Set([0]));
  const registry = (eufy as never as { registry: { record: (sn: string) => Promise<unknown> } }).registry;
  const record = vi
    .spyOn(registry, "record")
    .mockResolvedValue({ params: {}, dpParams: { 153: "work-status" } } as never);
  const context = vi.spyOn(eufy as never as { commandContext: () => unknown }, "commandContext");
  context.mockResolvedValue({ paramIds: new Set([0, 153]) } as never);
  const report = (...slices: Record<number, string>[]) =>
    (
      eufy as never as {
        applyRealtimeReport: (sn: string, s: readonly { params: Record<number, string> }[]) => void;
      }
    ).applyRealtimeReport(
      "VAC",
      slices.map((params) => ({ params })),
    );
  return { eufy, dev, record, context, report, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe("rebindReads", () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * A robot's report is decoded by two capabilities over disjoint id sets. Handled slice by slice, each
   * one widens the evidence on its own and the first report costs two concurrent
   * `get_device_param_list` POSTs — and announces itself twice.
   */
  it("re-binds once for a report two capabilities decoded", async () => {
    const { eufy, context, record, report, settle } = withDevice();
    const seen: unknown[] = [];
    eufy.on("deviceState", (s) => seen.push(s));

    report({ 153: "work-status" }, { 158: "suction" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2); // the report, then again once the reads exist
  });

  it("does not re-bind again for ids it has already seen", async () => {
    const { context, report, settle } = withDevice();

    report({ 153: "work-status" });
    await settle();
    report({ 153: "work-status-2" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
  });

  /**
   * The evidence advances whether or not the re-bind lands. A failure that left it un-advanced would make
   * every subsequent report try again — an uncached cloud POST per message, for as long as the device
   * keeps talking.
   */
  it("does not retry on every later report after a failure", async () => {
    const { context, report, settle } = withDevice({ warn: () => {} });
    context.mockRejectedValue(new Error("record gone") as never);

    report({ 153: "work-status" });
    await settle();
    report({ 153: "work-status-2" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
  });

  /**
   * `error` on an EventEmitter throws when nothing is listening, and this path is un-awaited — the throw
   * would surface as an unhandled rejection and abort the host process.
   */
  it("logs a failure instead of throwing when the host has no error listener", async () => {
    const warn = vi.fn();
    const { eufy, context, report, settle } = withDevice({ warn });
    context.mockRejectedValue(new Error("record gone") as never);

    report({ 153: "work-status" });
    await settle();

    expect(eufy.listenerCount("error")).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("record gone"));
  });

  it("emits the failure to a host that does listen", async () => {
    const { eufy, context, report, settle } = withDevice();
    context.mockRejectedValue(new Error("record gone") as never);
    const errors: Error[] = [];
    eufy.on("error", (e) => errors.push(e));

    report({ 153: "work-status" });
    await settle();

    expect(errors.map((e) => e.message)).toEqual(["record gone"]);
  });

  /**
   * The report that creates the reads is announced before they are installed, so a host reading them from
   * that event would see nothing. The same event fires again once they exist, which is what makes
   * "re-read on `deviceState`" true on the first report rather than only from the second.
   */
  it("announces the state again once the reads are installed", async () => {
    const { eufy, dev, report, settle } = withDevice();
    const seen: unknown[] = [];
    eufy.on("deviceState", (s) => seen.push(s));

    report({ 153: "work-status" });
    expect(seen).toHaveLength(1);
    expect(dev.bindActions).not.toHaveBeenCalled();
    await settle();

    expect(dev.bindActions).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
  });

  /**
   * The ids come back through the cloud record, which for a realtime-only line carries none of them — so
   * replacing the evidence with what the record knows would un-know the reported ids and re-trigger on the
   * next report.
   */
  it("widens the evidence rather than replacing it with what the record knows", async () => {
    const { eufy, context, report, settle } = withDevice();
    context.mockResolvedValue({ paramIds: new Set([0]) } as never);

    report({ 153: "work-status" });
    await settle();

    const bound = (eufy as never as { boundParamIds: Map<string, ReadonlySet<number>> }).boundParamIds.get("VAC");
    expect([...bound!].sort((a, b) => a - b)).toEqual([0, 153]);
  });

  /**
   * A property gated on a realtime-only param is outside the schema until that param is evidence, and
   * the report that made it evidence was stored before the property existed. Re-resolving first and
   * applying the record's realtime params again is what lands that value under the property's name.
   */
  it("re-resolves against the record and re-applies its realtime params before binding", async () => {
    const { dev, record, report, settle } = withDevice();

    report({ 153: "work-status" });
    await settle();

    const rec = await record.mock.results[0]!.value;
    expect(dev.reresolve).toHaveBeenCalledWith(rec);
    expect(dev.applyParams).toHaveBeenLastCalledWith({ 153: "work-status" });
    expect(dev.reresolve.mock.invocationCallOrder[0]).toBeLessThan(dev.bindActions.mock.invocationCallOrder[0]!);
  });
  it("does not overwrite a newer poll reconciliation with an older pending rebind", async () => {
    const { eufy, dev, record, context, settle } = withDevice();
    const oldContext = deferred<{ paramIds: Set<number> }>();
    const oldRecord = { params: {}, dpParams: { 156: "0" } };
    const polled = { sn: "VAC", model: "T2351", category: "eufy_home", params: { 156: "1" } };
    record.mockResolvedValue(oldRecord as never);
    context.mockReturnValueOnce(oldContext.promise as never).mockResolvedValue({ paramIds: new Set([156]) });
    const registry = (eufy as never as { registry: { list: () => unknown; pollChanges: () => unknown } }).registry;
    vi.spyOn(registry, "list").mockReturnValue([polled]);
    vi.spyOn(registry, "pollChanges").mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    const older = rebind(eufy);
    await settle();
    await (eufy as never as { pollOnce: () => Promise<void> }).pollOnce();
    oldContext.resolve({ paramIds: new Set([156]) });
    await older;

    expect(dev.reresolve).toHaveBeenCalledOnce();
    expect(dev.reresolve).toHaveBeenCalledWith(
      expect.objectContaining({ model: polled.model, category: polled.category, params: polled.params }),
    );
    expect(record).toHaveBeenCalledOnce();
    expect(dev.applyParams).not.toHaveBeenCalledWith(oldRecord.dpParams);
    expect(dev.bindActions).not.toHaveBeenCalled();
  });
});

const CAMERA = "T8000P0000000000";
const WIFI_RSSI = 1142;

interface HeldCameraClient {
  registry: DeviceRegistry;
  commandContext(sn: string, record?: DeviceRecord): Promise<CommandContext>;
  commandSinkFor(sn: string): CommandSink;
  mediaProviderFor(sn: string): undefined;
  ff09SettingsReaderFor(sn: string, ctx: CommandContext): undefined;
  awaitFirstRealtimeState(sn: string): Promise<void>;
  applyRealtimeReport(sn: string, states: readonly { params: Record<number, string> }[]): void;
  pollOnce(): Promise<void>;
}

/** Actual registry diffs and held model state, with local responses at the external request boundary. */
async function heldCamera(params: Record<number, string> = {}, model = "T8114") {
  const cloud = { model, params: { 1101: "80", ...params } as Record<number, string> };
  const fetchParams = vi.fn(async () => ({}));
  const post = vi.fn(async (_service: string, path: string) =>
    path.endsWith("get_house_list")
      ? { house_infos: [] }
      : {
          devices: [
            {
              device_sn: CAMERA,
              device_model: cloud.model,
              device_type: 9,
              station_sn: CAMERA,
              category: "eufy_security",
              params: Object.entries(cloud.params).map(([param_type, param_value]) => ({
                param_type: Number(param_type),
                param_value,
              })),
            },
          ],
        },
  );
  const eufy = new EufyMega({ email: "t@example.com", password: "x", autoRealtime: false });
  const internals = eufy as unknown as HeldCameraClient;
  internals.registry = new DeviceRegistry({
    mega: { post, getDeviceParamList: fetchParams } as unknown as MegaHttpClient,
    onError: (error) => {
      throw error;
    },
  });
  const errors: Error[] = [];
  eufy.on("error", (error) => errors.push(error));
  const context = vi.spyOn(internals, "commandContext").mockImplementation(async (_sn, record) => ({
    codec: "camera",
    model,
    category: "eufy_security",
    deviceType: 9,
    channel: 0,
    paramIds: new Set([...Object.keys(cloud.params), ...Object.keys(record?.dpParams ?? {})].map(Number)),
  }));
  const dispatch = vi.fn(async () => {});
  vi.spyOn(internals, "commandSinkFor").mockReturnValue({ dispatch });
  vi.spyOn(internals, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(internals, "ff09SettingsReaderFor").mockReturnValue(undefined);
  vi.spyOn(internals, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  const pollChanges = vi.spyOn(internals.registry, "pollChanges");
  await internals.registry.pollChanges();
  const dev = await eufy.getDevice(CAMERA);
  const seen: { deviceSn: string; property: string; value?: unknown }[] = [];
  const readInAnnouncement: unknown[] = [];
  eufy.on("propertyChanged", (event) => {
    seen.push(event);
    if (event.property === "wifiRssi") readInAnnouncement.push(dev.camera?.()?.wifiRssi);
  });
  const report = async (next: Record<number, string>) => {
    internals.applyRealtimeReport(CAMERA, [{ params: next }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
  };
  const poll = async (next: Record<number, string>) => {
    cloud.params = next;
    await internals.pollOnce();
    expect(errors).toEqual([]);
    return pollChanges.mock.results.at(-1)!.value;
  };
  return { eufy, dev, seen, readInAnnouncement, report, poll, dispatch, context, fetchParams, post, cloud };
}

/** Schema, typed getter and loose reads refer to one unitless reported value. */
function expectSignal(dev: Device, value: number) {
  const spec = dev.properties.find((property) => property.name === "wifiRssi");
  expect.soft(spec).toMatchObject({ paramType: WIFI_RSSI, type: "number", kind: "scalar", writable: false });
  expect.soft(spec?.unit).toBeUndefined();
  expect.soft(dev.camera?.()?.wifiRssi).toBe(value);
  expect.soft(dev.getProperty("wifiRssi")?.value).toBe(value);
  expect.soft(dev.getProperties().wifiRssi?.value).toBe(value);
}

describe("reported camera Wi-Fi on a held Device", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("replays the first realtime value when the asynchronous read rebind completes", async () => {
    const { eufy, dev, seen, report, context, fetchParams, post, dispatch } = await heldCamera();
    const reads: unknown[] = [];
    eufy.on("deviceState", () => reads.push(dev.camera?.()?.wifiRssi));
    expect(dev.hasProperty("wifiRssi")).toBe(false);
    expect(dev.camera?.()).not.toHaveProperty("wifiRssi");

    await report({ [WIFI_RSSI]: "-61" });

    expectSignal(dev, -61);
    expect(seen).toEqual([{ deviceSn: CAMERA, property: "wifiRssi", value: -61 }]);
    expect(dev.getProperty("unknown_1142")?.value).toBe("-61");
    expect(reads).toEqual([undefined, -61]);
    expect(context).toHaveBeenCalledTimes(2);
    expect(fetchParams.mock.calls.length).toBeLessThanOrEqual(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("exposes a first cloud value without requiring a prior value transition or capability gain", async () => {
    const { dev, seen, poll, context, fetchParams, dispatch } = await heldCamera();
    const capabilities = [...dev.capabilities];

    const diff = await poll({ 1101: "80", [WIFI_RSSI]: "-67" });

    expect(diff.params).toEqual([]);
    expectSignal(dev, -67);
    expect(dev.capabilities).toEqual(capabilities);
    expect(seen).toEqual([]);
    expect(context).toHaveBeenCalledTimes(1);
    expect(fetchParams).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("announces later cloud and realtime values coherently without rebinding existing reads", async () => {
    const { dev, seen, readInAnnouncement, poll, report, context, fetchParams, dispatch } = await heldCamera({
      [WIFI_RSSI]: "-71",
    });

    await poll({ 1101: "80", [WIFI_RSSI]: "-69" });
    expectSignal(dev, -69);
    await report({ [WIFI_RSSI]: "0" });
    expectSignal(dev, 0);

    expect(seen).toEqual([
      { deviceSn: CAMERA, property: "wifiRssi", value: -69 },
      { deviceSn: CAMERA, property: "wifiRssi", value: 0 },
    ]);
    expect(readInAnnouncement).toEqual([-69, 0]);
    expect(context).toHaveBeenCalledTimes(1);
    expect(fetchParams.mock.calls.length).toBeLessThanOrEqual(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a reported value coherent through an omitted cloud field and its next realtime report", async () => {
    const { dev, seen, poll, report, context, dispatch } = await heldCamera({ [WIFI_RSSI]: "-71" });

    await poll({ 1101: "79" });
    expectSignal(dev, -71);
    await report({ [WIFI_RSSI]: "-69" });
    expectSignal(dev, -69);

    expect(seen.filter((event) => event.property === "wifiRssi")).toEqual([
      { deviceSn: CAMERA, property: "wifiRssi", value: -69 },
    ]);
    expect(context).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("adopts a withheld signal after a fresh report without reconstructing its prior normalized cache", async () => {
    const { dev, dispatch } = await heldCamera();
    dev.applyParams({ [WIFI_RSSI]: "-75" });
    dev.reresolve({ model: "T8114", category: "eufy_security", deviceType: 9, params: { [WIFI_RSSI]: "-75" } });
    dev.bindActions(
      { codec: "camera", model: "T8114", deviceType: 9, channel: 0, paramIds: new Set([1101, WIFI_RSSI]) },
      { dispatch },
    );

    expect(dev.camera?.()?.wifiRssi).toBeUndefined();
    expect(dev.getProperty("unknown_1142")?.value).toBe("-75");
    dev.applyParams({ [WIFI_RSSI]: "-74" });
    expectSignal(dev, -74);
    expect(dev.getProperty("unknown_1142")?.value).toBe("-75");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a realtime signal over stale cloud siblings and a reintroduced field", async () => {
    const { dev, seen, poll, report, fetchParams, dispatch } = await heldCamera({ [WIFI_RSSI]: "-71" });
    await report({ [WIFI_RSSI]: "-63" });
    seen.length = 0;
    await poll({ 1101: "79", [WIFI_RSSI]: "-71" });
    expectSignal(dev, -63);
    await poll({ 1101: "79" });
    await poll({ 1101: "79", [WIFI_RSSI]: "-71" });
    expectSignal(dev, -63);
    expect(seen).toEqual([{ deviceSn: CAMERA, property: "battery", value: 79 }]);
    await poll({ 1101: "79", [WIFI_RSSI]: "-70" });
    expectSignal(dev, -70);
    expect(seen.at(-1)).toEqual({ deviceSn: CAMERA, property: "wifiRssi", value: -70 });
    expect(fetchParams).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the held signal observation unchanged when a poll supplies no value transition", async () => {
    const { dev, seen, poll, fetchParams, dispatch } = await heldCamera({ [WIFI_RSSI]: "0" });
    const first = dev.getProperty("wifiRssi");
    await poll({ 1101: "80", [WIFI_RSSI]: "0" });
    expect(dev.getProperty("wifiRssi")).toEqual(first);
    expectSignal(dev, 0);
    expect(seen).toEqual([]);
    expect(fetchParams).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the first realtime signal when a cached poll completes before its pending rebind", async () => {
    const { dev, report, poll, context, fetchParams, dispatch } = await heldCamera();
    const pending = deferred<CommandContext>();
    context.mockReturnValueOnce(pending.promise);
    await report({ [WIFI_RSSI]: "-61" });
    expect(context).toHaveBeenCalledTimes(2);
    await poll({ 1101: "79" });
    pending.resolve({
      codec: "camera",
      model: "T8114",
      category: "eufy_security",
      deviceType: 9,
      channel: 0,
      paramIds: new Set([1101, WIFI_RSSI]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectSignal(dev, -61);
    expect(fetchParams.mock.calls.length).toBeLessThanOrEqual(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a capability learned from the pending record overlay when a cached poll finishes first", async () => {
    const { dev, report, poll, context, fetchParams, dispatch } = await heldCamera({}, "T8170");
    expect(dev.has("light")).toBe(false);
    const pending = deferred<CommandContext>();
    fetchParams.mockResolvedValue({ params: [{ param_type: 1400, param_value: "1" }] });
    context.mockReturnValueOnce(pending.promise);
    await report({ 1400: "1" });
    expect(context).toHaveBeenCalledTimes(2);
    expect(context.mock.calls[1]?.[1]?.params).toHaveProperty("1400", "1");
    await poll({ 1101: "79" });
    pending.resolve({
      codec: "camera",
      model: "T8170",
      category: "eufy_security",
      deviceType: 9,
      channel: 0,
      paramIds: new Set([1101, 1400]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dev.has("light")).toBe(true);
    expect(dev.light?.()?.isOn).toBe(true);
    expect(dev.getProperty("light")?.value).toBe(true);
    expect(fetchParams).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a later cloud transition over the signal snapshot in a pending rebind", async () => {
    const { dev, report, poll, context, fetchParams, dispatch } = await heldCamera({ [WIFI_RSSI]: "-71" });
    const pending = deferred<CommandContext>();
    context.mockReturnValueOnce(pending.promise);
    await report({ [WIFI_RSSI]: "-61", 1400: "1" });
    expect(context).toHaveBeenCalledTimes(2);
    await poll({ 1101: "80", [WIFI_RSSI]: "-67" });
    expectSignal(dev, -67);
    pending.resolve({
      codec: "camera",
      model: "T8114",
      category: "eufy_security",
      deviceType: 9,
      channel: 0,
      paramIds: new Set([1101, WIFI_RSSI, 1400]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectSignal(dev, -67);
    expect(fetchParams).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an older overlay after a cached poll changes the camera model", async () => {
    const { dev, report, poll, context, fetchParams, dispatch, cloud } = await heldCamera({}, "T8170");
    const pending = deferred<CommandContext>();
    fetchParams.mockResolvedValue({ params: [{ param_type: 1400, param_value: "1" }] });
    context.mockReturnValueOnce(pending.promise);
    await report({ 1400: "1" });
    expect(context.mock.calls[1]?.[1]?.params).toHaveProperty("1400", "1");
    cloud.model = "T8114";
    await poll({ 1101: "79" });
    expect(dev.model).toBe("T8114");
    expect(dev.getProperty("light")?.value).not.toBe(true);
    const capabilities = [...dev.capabilities];
    const apply = vi.spyOn(dev, "applyParams");
    pending.resolve({
      codec: "camera",
      model: "T8170",
      category: "eufy_security",
      deviceType: 9,
      channel: 0,
      paramIds: new Set([1101, 1400]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dev.model).toBe("T8114");
    expect(dev.capabilities).toEqual(capabilities);
    expect(dev.light?.()?.isOn).toBeUndefined();
    expect(dev.getProperty("light")).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(fetchParams).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
