import type { IntegrationAdapter, IntegrationConfig, ScopeStatus } from "../types.js";
import { fetchJson, fetchRaw, joinUrl } from "../types.js";

/**
 * NINA (Nighttime Imaging 'N' Astronomy) via the **Advanced API** plugin. That
 * plugin serves a read-only-friendly REST API (default port 1888) under
 * `/v2/api`, with no authentication of its own — access is gated purely by the
 * network, so all this integration needs is a reachable URL (a LAN or Tailscale
 * address to the imaging PC). Every response is wrapped in an envelope:
 *   { Response, Error, StatusCode, Success, Type }
 *
 * We poll the equipment `…/info` endpoints and image-history, normalise them
 * into one ScopeStatus, and only surface devices that are actually connected.
 * Nothing here is specific to one rig — point it at your own NINA and it adapts
 * to whatever gear is connected.
 */

interface NinaEnvelope<T> {
  Response?: T;
  Success?: boolean;
  Error?: string;
  StatusCode?: number;
}

/** Base URL with the /v2/api prefix, tolerating a URL that already includes it. */
function apiBase(cfg: IntegrationConfig): string {
  const root = cfg.url.replace(/\/+$/, "");
  return /\/v2\/api$/i.test(root) ? root : `${root}/v2/api`;
}

/** Envelope-aware GET. Throws on unreachable/HTTP error; returns null when the
 *  call succeeded but carries no usable object (e.g. a device isn't connected). */
async function ninaGet<T>(
  cfg: IntegrationConfig,
  path: string,
  timeoutMs = 7000
): Promise<T | null> {
  const env = await fetchJson<NinaEnvelope<T>>(joinUrl(apiBase(cfg), path), {}, timeoutMs);
  if (!env?.Success) return null;
  const r = env.Response;
  return r != null && typeof r === "object" ? (r as T) : null;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const seconds = (v: unknown): number | undefined => {
  const n = num(v);
  return n != null && n > 0 ? n : undefined;
};

export const nina: IntegrationAdapter = {
  type: "nina",
  label: "NINA (telescope)",
  urlPlaceholder: "http://100.x.x.x:1888",
  capabilities: ["scope", "status"],
  fields: [],

  async test(cfg) {
    const t0 = Date.now();
    const env = await fetchJson<NinaEnvelope<string>>(joinUrl(apiBase(cfg), "/version"));
    const latencyMs = Date.now() - t0;
    if (!env?.Success) throw new Error(env?.Error || "NINA Advanced API did not report success");
    return {
      ok: true,
      latencyMs,
      version: typeof env.Response === "string" ? env.Response : undefined,
      message: "NINA Advanced API reachable",
    };
  },

  async fetchScope(cfg) {
    // /version is the reachability probe: if NINA (or the plugin) is down this
    // throws and the widget shows the error, rather than a misleading "all idle".
    await fetchJson<NinaEnvelope<string>>(joinUrl(apiBase(cfg), "/version"));

    // Per-device calls are independent — one disconnected device (which some
    // drivers answer with a 500) must not blank out the rest.
    const off = () => null;
    const [cam, mount, guider, guideGraph, focuser, fw, weather, images] = await Promise.all([
      ninaGet<any>(cfg, "/equipment/camera/info").catch(off),
      ninaGet<any>(cfg, "/equipment/mount/info").catch(off),
      ninaGet<any>(cfg, "/equipment/guider/info").catch(off),
      ninaGet<any>(cfg, "/equipment/guider/graph").catch(off),
      ninaGet<any>(cfg, "/equipment/focuser/info").catch(off),
      ninaGet<any>(cfg, "/equipment/filterwheel/info").catch(off),
      ninaGet<any>(cfg, "/equipment/weather/info").catch(off),
      ninaGet<any[]>(cfg, "/image-history?all=true").catch(off),
    ]);

    const status: ScopeStatus = {
      source: { id: cfg.id, type: cfg.type, name: cfg.name },
      reachable: true,
      anyConnected: false,
    };

    if (cam?.Connected) {
      status.camera = {
        name: cam.DisplayName || cam.Name,
        state: typeof cam.CameraState === "string" ? cam.CameraState : undefined,
        exposing: !!cam.IsExposing,
        exposureEndTime: cam.ExposureEndTime || undefined,
        temperatureC: num(cam.Temperature),
        targetTempC: num(cam.TargetTemp),
        atTargetTemp: typeof cam.AtTargetTemp === "boolean" ? cam.AtTargetTemp : undefined,
        coolerOn: typeof cam.CoolerOn === "boolean" ? cam.CoolerOn : undefined,
        coolerPowerPct: num(cam.CoolerPower),
        dewHeaterOn: typeof cam.DewHeaterOn === "boolean" ? cam.DewHeaterOn : undefined,
        gain: num(cam.Gain),
        offset: num(cam.Offset),
      };
    }

    if (mount?.Connected) {
      status.mount = {
        name: mount.DisplayName || mount.Name,
        tracking: typeof mount.TrackingEnabled === "boolean" ? mount.TrackingEnabled : undefined,
        slewing: typeof mount.Slewing === "boolean" ? mount.Slewing : undefined,
        atPark: typeof mount.AtPark === "boolean" ? mount.AtPark : undefined,
        atHome: typeof mount.AtHome === "boolean" ? mount.AtHome : undefined,
        raString: mount.RightAscensionString || mount.Coordinates?.RAString || undefined,
        decString: mount.DeclinationString || mount.Coordinates?.DecString || undefined,
        altitude: num(mount.Altitude),
        azimuth: num(mount.Azimuth),
        sideOfPier: typeof mount.SideOfPier === "string" ? mount.SideOfPier : undefined,
        meridianFlipHours: num(mount.TimeToMeridianFlip),
      };
    }

    if (guider?.Connected) {
      const rms = guider.RMSError ?? {};
      // The guide graph reports each step's error in *pixels*; RMS.Scale is the
      // pixel scale (arcsec/pixel), so multiply to get arcseconds for the graph.
      const steps: any[] = Array.isArray(guideGraph?.GuideSteps) ? guideGraph.GuideSteps : [];
      const scale = num(guideGraph?.RMS?.Scale) ?? 1;
      const history = steps
        .map((s) => ({ ra: num(s.RADistanceRaw), dec: num(s.DECDistanceRaw) }))
        .filter((s): s is { ra: number; dec: number } => s.ra != null && s.dec != null)
        .map((s) => ({ ra: s.ra * scale, dec: s.dec * scale }));
      status.guider = {
        name: guider.DisplayName || guider.Name,
        state: typeof guider.State === "string" ? guider.State : undefined,
        rmsTotalArcsec: num(rms.Total?.Arcseconds),
        rmsRaArcsec: num(rms.RA?.Arcseconds),
        rmsDecArcsec: num(rms.Dec?.Arcseconds),
        history: history.length > 1 ? history : undefined,
      };
    }

    if (focuser?.Connected) {
      status.focuser = {
        name: focuser.DisplayName || focuser.Name,
        position: num(focuser.Position),
        temperatureC: num(focuser.Temperature),
        moving: typeof focuser.IsMoving === "boolean" ? focuser.IsMoving : undefined,
      };
    }

    if (fw?.Connected) {
      status.filterWheel = {
        name: fw.DisplayName || fw.Name,
        filter: fw.SelectedFilter?.Name || undefined,
        moving: typeof fw.IsMoving === "boolean" ? fw.IsMoving : undefined,
      };
    }

    if (weather?.Connected) {
      status.weather = {
        name: weather.DisplayName || weather.Name,
        temperatureC: num(weather.Temperature),
        humidityPct: num(weather.Humidity),
        cloudCoverPct: num(weather.CloudCover),
        windSpeedMs: num(weather.WindSpeed),
        dewPointC: num(weather.DewPoint),
      };
    }

    // image-history is a chronological array; the newest capture is last, and
    // its position is the index the image/thumbnail endpoints expect.
    if (Array.isArray(images) && images.length) {
      const index = images.length - 1;
      const last = images[index] ?? {};
      status.lastImage = {
        index,
        hfr: num(last.HFR),
        stars: num(last.Stars),
        filter: last.Filter || undefined,
        exposureSeconds: seconds(last.ExposureTime),
        temperatureC: num(last.Temperature),
        rms: last.RmsText || undefined,
        date: last.Date || undefined,
        mean: num(last.Mean),
        imageType: last.ImageType || undefined,
      };
    }

    status.anyConnected = Boolean(
      status.camera ||
      status.mount ||
      status.guider ||
      status.focuser ||
      status.filterWheel ||
      status.weather
    );
    return status;
  },

  // Preview of a captured frame, proxied so the browser never needs a route to
  // the imaging PC. `artPath` is the image-history index. We prefer NINA's
  // purpose-built 256px thumbnail; if thumbnails are disabled it 400s, so we
  // fall back to a scaled, auto-stretched render of the full image.
  async fetchArt(cfg, artPath) {
    const index = encodeURIComponent(artPath);
    const thumb = await fetchRaw(
      joinUrl(apiBase(cfg), `/image/thumbnail/${index}`),
      {},
      12000
    ).catch(() => null);
    const ct = thumb?.headers.get("content-type") ?? "";
    if (thumb?.ok && ct.startsWith("image/")) return thumb;
    // fallback: full image, scaled down and stretched exactly as NINA shows it
    return fetchRaw(
      joinUrl(
        apiBase(cfg),
        `/image/${index}?resize=true&scale=0.25&stream=true&autoPrepare=true&quality=80`
      ),
      {},
      20000
    );
  },
};
