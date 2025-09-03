import React, { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MapContainer, TileLayer, Marker, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * GALAMWATCH — Minimal MVP (clean & mobile friendly)
 * Tabs: New Report | My Reports | Map | Help
 * Storage: LocalStorage only
 * No stealth, no upload-when-safe, no checklist, no rewards, no SMS/USSD, no settings
 */

// ---- Leaflet marker icon fix (so markers show on mobile) ----
const DefaultIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
(L.Marker.prototype as any).options.icon = DefaultIcon;

// ---- Utils ----
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const toRad = (d: number) => (d * Math.PI) / 180;
const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
function randomPointInRing(lat: number, lon: number, minM: number, maxM: number) {
  const bearing = Math.random() * 2 * Math.PI;
  const d = minM + Math.random() * (maxM - minM);
  const R = 6371e3,
    phi1 = toRad(lat),
    lam1 = toRad(lon);
  const phi2 =
    Math.asin(
      Math.sin(phi1) * Math.cos(d / R) +
        Math.cos(phi1) * Math.sin(d / R) * Math.cos(bearing)
    );
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d / R) * Math.cos(phi1),
      Math.cos(d / R) - Math.sin(phi1) * Math.sin(phi2)
    );
  return { lat: (phi2 * 180) / Math.PI, lon: (lam2 * 180) / Math.PI };
}
const pointsKey = (pts: number[][]) =>
  pts
    .filter((p) => p && isFinite(p[0]) && isFinite(p[1]))
    .map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`)
    .join("|");

function FitToBounds({ points }: { points: number[][] }) {
  const map = useMap();
  const sig = useMemo(() => pointsKey(points), [points]);
  useEffect(() => {
    if (!map || points.length === 0) return;
    const latlngs = points.map((p) => L.latLng(p[0], p[1]));
    if (latlngs.length === 1) (map as any).setView(latlngs[0], 15);
    else (map as any).fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
  }, [map, sig]);
  return null;
}

// ---- Storage ----
const LS_REPORTS = "gw_reports_v1";
const LS_DRAFT = "gw_draft_v1";

const safeParse = <T,>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const loadReports = () =>
  typeof window === "undefined" ? [] : safeParse<Report[]>(localStorage.getItem(LS_REPORTS), []);
const saveReports = (r: Report[]) => localStorage.setItem(LS_REPORTS, JSON.stringify(r));
const loadDraft = () =>
  typeof window === "undefined" ? null : safeParse<any>(localStorage.getItem(LS_DRAFT), null);
const saveDraft = (d: any) => localStorage.setItem(LS_DRAFT, JSON.stringify(d));

// ---- Types ----
type Media = { type: "image" | "video" | "audio"; name: string; dataUrl: string };
type Report = {
  id: string;
  createdAt: string;
  category: string;
  description: string;
  gps: { lat: number; lon: number; accuracy?: number };
  blurRadius: number;
  publicOffset: { lat: number; lon: number };
  media: Media[];
  status: "Submitted" | "Received" | "In Progress" | "Resolved";
  history: { state: string; at: string }[];
};

// ---- EXIF scrub by re-encoding via Canvas (images only) ----
async function sanitizeImage(file: File, maxDim = 1600) {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const isPng = (file.type || "").includes("png");
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.92);
}

export default function App() {
  // ---- App state ----
  const [tab, setTab] = useState<"report" | "my" | "map" | "help">("report");
  const [reports, setReports] = useState<Report[]>(loadReports());
  const [userLoc, setUserLoc] = useState<null | { lat: number; lon: number; accuracy?: number }>(null);
  const [privateView, setPrivateView] = useState(true);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [banner, setBanner] = useState<null | { type: "error" | "success" | "info"; text: string }>(null);

  const initialForm = {
    category: "",
    description: "",
    gps: null as null | { lat: number; lon: number; accuracy?: number },
    manualLat: "",
    manualLon: "",
    blurRadius: 300,
    media: [] as Media[],
  };
  const [form, setForm] = useState<any>(() => loadDraft() ?? initialForm);

  useEffect(() => saveReports(reports), [reports]);
  useEffect(() => saveDraft(form), [form]);

  // ---- Geolocation ----
  const captureGps = () => {
    if (!navigator.geolocation) {
      setBanner({ type: "error", text: "Geolocation not supported on this device." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setUserLoc(d);
        setForm((f: any) => ({ ...f, gps: d, manualLat: "", manualLon: "" }));
      },
      () => setBanner({ type: "error", text: "Could not get GPS. Check permission/location settings." }),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
    );
  };
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    return () => {
      try {
        (navigator.geolocation as any).clearWatch?.(id);
      } catch {}
    };
  }, []);

  // ---- Files ----
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: Media["type"]) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const dataUrl =
        type === "image"
          ? await sanitizeImage(f)
          : await new Promise<string>((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result as string);
              fr.onerror = rej;
              fr.readAsDataURL(f);
            });
      setForm((v: any) => ({ ...v, media: [...v.media, { type, name: f.name, dataUrl }] }));
    } catch {
      setBanner({ type: "error", text: "Could not process file." });
    } finally {
      e.target.value = "";
    }
  };
  const removeMedia = (i: number) =>
    setForm((v: any) => ({ ...v, media: v.media.filter((_: any, idx: number) => idx !== i) }));

  // ---- Submit ----
  const submitReport = () => {
    setBanner(null);
    const desc = String(form.description || "").trim();
    if (!desc) {
      setBanner({ type: "error", text: "Please add a short description." });
      return;
    }

    // Use GPS: captured or manual
    let gps = form.gps as null | { lat: number; lon: number; accuracy?: number };
    const latNum = Number(form.manualLat),
      lonNum = Number(form.manualLon);
    const latOk = isFinite(latNum) && latNum >= -90 && latNum <= 90;
    const lonOk = isFinite(lonNum) && lonNum >= -180 && lonNum <= 180;
    if (!gps && latOk && lonOk) gps = { lat: latNum, lon: lonNum };

    if (!gps) {
      setBanner({ type: "error", text: "Please tap Use My Location or enter latitude and longitude." });
      return;
    }

    const id = uuidv4();
    const br = clamp(Number(form.blurRadius || 0), 0, 2000);
    const offset =
      br > 0 ? randomPointInRing(gps.lat, gps.lon, Math.max(1, br * 0.5), br) : { lat: gps.lat, lon: gps.lon };
    const nowIso = new Date().toISOString();
    const r: Report = {
      id,
      createdAt: nowIso,
      category: form.category || "Unspecified",
      description: desc,
      gps,
      blurRadius: br,
      publicOffset: offset,
      media: form.media,
      status: "Submitted",
      history: [{ state: "Submitted", at: nowIso }],
    };

    setReports((prev) => [r, ...prev]);
    setForm(initialForm);
    setBanner({ type: "success", text: "Report submitted. Track it in My Reports." });

    // Simulate backend acknowledgement
    setTimeout(() => {
      setReports((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, status: "Received", history: [...x.history, { state: "Received", at: new Date().toISOString() }] } : x
        )
      );
    }, 900);
    setTab("my");
  };

  // ---- Small UI atoms ----
  const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <section className="bg-white rounded-2xl shadow p-4 sm:p-6 mb-5">
      <h2 className="text-lg sm:text-xl font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
  const Timeline = ({ status }: { status: Report["status"] }) => {
    const steps: Report["status"][] = ["Submitted", "Received", "In Progress", "Resolved"];
    return (
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {steps.map((s, idx) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`px-2 py-1 rounded ${steps.indexOf(status) >= idx ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
              {s}
            </div>
            {idx < steps.length - 1 && <div className="h-px w-6 bg-gray-300" />}
          </div>
        ))}
      </div>
    );
  };
  const SafetyNotes = () => (
    <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
      <li>Do not confront anyone. Keep a safe distance.</li>
      <li>Capture landmarks (bridge, bend) instead of faces/plates.</li>
      <li>Use a blur radius to hide the exact point on public maps.</li>
      <li>Never go onto private sites or dangerous areas.</li>
    </ul>
  );

  // ---- Header ----
  const Header = () => (
    <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-base sm:text-lg">Galamwatch</span>
          <span className="hidden sm:inline text-xs text-gray-500">Privacy-first • Offline-ready</span>
        </div>
        <nav className="flex gap-1">
          {[
            { k: "report", label: "New Report" },
            { k: "my", label: "My Reports" },
            { k: "map", label: "Map" },
            { k: "help", label: "Help" },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k as any)}
              className={`px-3 py-1.5 rounded-xl text-sm ${tab === (t.k as any) ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );

  // ---- Screens ----
  const NewReport = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      {banner && (
        <div
          className={`mb-3 rounded-xl px-3 py-2 text-sm ${
            banner.type === "error"
              ? "bg-red-50 text-red-700"
              : banner.type === "success"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-blue-50 text-blue-800"
          }`}
        >
          {banner.text}
        </div>
      )}

      <Section title="Reporting Form">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium">Category</label>
            <select
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={form.category}
              onChange={(e) => setForm((f: any) => ({ ...f, category: e.target.value }))}
            >
              <option value="">Select… (optional)</option>
              <option>River dredging</option>
              <option>Excavator in reserve</option>
              <option>Chemical use</option>
              <option>Night trucking</option>
              <option>Pit hazard near school</option>
              <option>Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium">GPS Location</label>
            <div className="mt-1 flex items-center gap-2">
              <button onClick={captureGps} className="px-3 py-2 rounded-xl bg-gray-900 text-white">
                Use My Location
              </button>
              {form.gps ? (
                <span className="text-sm text-gray-700">
                  {form.gps.lat.toFixed(5)}, {form.gps.lon.toFixed(5)} • ±{Math.round(form.gps.accuracy || 0)} m
                </span>
              ) : (
                <span className="text-sm text-gray-500">No location yet</span>
              )}
            </div>
            {/* Manual GPS fallback */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                inputMode="decimal"
                className="rounded-xl border px-3 py-2 text-sm"
                placeholder="Latitude (e.g., 5.6037)"
                value={form.manualLat}
                onChange={(e) => setForm((f: any) => ({ ...f, manualLat: e.target.value }))}
              />
              <input
                inputMode="decimal"
                className="rounded-xl border px-3 py-2 text-sm"
                placeholder="Longitude (e.g., -0.1870)"
                value={form.manualLon}
                onChange={(e) => setForm((f: any) => ({ ...f, manualLon: e.target.value }))}
              />
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium">Description</label>
            <textarea
              className="mt-1 w-full rounded-xl border px-3 py-2 min-h-[110px]"
              placeholder="What did you see? When? Any landmarks?"
              value={form.description}
              onChange={(e) => setForm((f: any) => ({ ...f, description: e.target.value }))}
            />
          </div>
        </div>

        {/* Media */}
        <div className="mt-4 grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium">Add Photo</label>
            <input type="file" accept="image/*" capture="environment" onChange={(e) => onFileChange(e, "image")} />
          </div>
          <div>
            <label className="block text-sm font-medium">Add Video</label>
            <input type="file" accept="video/*" capture="environment" onChange={(e) => onFileChange(e, "video")} />
          </div>
          <div>
            <label className="block text-sm font-medium">Add Voice Note</label>
            <input type="file" accept="audio/*" onChange={(e) => onFileChange(e, "audio")} />
          </div>
        </div>
        {form.media.length > 0 && (
          <div className="mt-3 grid sm:grid-cols-3 gap-3">
            {form.media.map((m: Media, i: number) => (
              <div key={i} className="border rounded-xl p-2">
                <div className="text-xs text-gray-500 mb-1">
                  {m.type} • {m.name}
                </div>
                {m.type === "image" && <img src={m.dataUrl} className="w-full h-36 object-cover rounded-lg" alt="" />}
                {m.type === "video" && <video src={m.dataUrl} className="w-full rounded-lg" controls />}
                {m.type === "audio" && <audio src={m.dataUrl} className="w-full" controls />}
                <div className="mt-2 flex justify-end">
                  <button onClick={() => removeMedia(i)} className="text-xs text-red-600">
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Geo-Privacy */}
        <div className="mt-4">
          <label className="block text-sm font-medium">Geo-Privacy Blur Radius (meters)</label>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={form.blurRadius}
            onChange={(e) => setForm((f: any) => ({ ...f, blurRadius: Number(e.target.value) }))}
            className="w-full"
          />
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div className="flex gap-2">
              {[0, 100, 300, 500, 1000, 2000].map((m) => (
                <button
                  key={m}
                  onClick={() => setForm((f: any) => ({ ...f, blurRadius: m }))}
                  className="px-2 py-1 rounded bg-gray-100"
                >
                  {m}m
                </button>
              ))}
            </div>
            <span>
              Selected: <b>{form.blurRadius} m</b>
            </span>
          </div>
          <p className="mt-2 text-xs text-gray-600">
            <b>How it works:</b> Public maps hide the exact point. The public pin appears at a random place inside your
            blur circle. Authorized systems in the future can see the exact coordinates. Set 0 m to disable.
          </p>
        </div>

        {/* Actions */}
        <div className="mt-6 flex items-center justify-between">
          <SafetyNotes />
          <div className="flex gap-2">
            <button onClick={submitReport} className="px-4 py-2 rounded-xl bg-emerald-600 text-white">
              Submit Report
            </button>
          </div>
        </div>
      </Section>

      <Section title="Blur Preview Map (Public vs Private)">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-gray-700">
            Current view: <b>{privateView ? "Private (raw)" : "Public (blurred)"}</b>
          </div>
          <button onClick={() => setPrivateView((v) => !v)} className="px-3 py-1.5 rounded-xl bg-gray-900 text-white">
            Toggle View
          </button>
        </div>
        <div className="h-[300px] rounded-xl overflow-hidden border">
          <LeafletPreview
            gps={
              form.gps ||
              (form.manualLat && form.manualLon
                ? { lat: Number(form.manualLat), lon: Number(form.manualLon) }
                : null)
            }
            blurRadius={form.blurRadius}
            privateView={privateView}
          />
        </div>
      </Section>
    </div>
  );

  function LeafletPreview({
    gps,
    blurRadius,
    privateView,
  }: {
    gps: any;
    blurRadius: number;
    privateView: boolean;
  }) {
    const center = gps ? [gps.lat, gps.lon] : [5.556, -0.1969]; // Accra
    const offset = useMemo(() => {
      if (!gps) return null;
      const br = clamp(Number(blurRadius || 0), 0, 2000);
      if (br <= 0) return { lat: gps.lat, lon: gps.lon };
      return randomPointInRing(gps.lat, gps.lon, Math.max(1, br * 0.5), br);
    }, [gps ? gps.lat : null, gps ? gps.lon : null, blurRadius]);

    return (
      <MapContainer center={center as any} zoom={15} style={{ height: "100%", width: "100%" }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
        {gps && privateView && (
          <>
            <Marker position={[gps.lat, gps.lon] as any} />
            <Circle center={[gps.lat, gps.lon] as any} radius={gps.accuracy || 15} />
          </>
        )}
        {gps && !privateView && offset && (
          <>
            <Marker position={[offset.lat, offset.lon] as any} />
            <Circle center={[gps.lat, gps.lon] as any} radius={clamp(Number(blurRadius || 0), 0, 2000)} />
          </>
        )}
      </MapContainer>
    );
  }

  const MyReports = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="My Reports">
        {reports.length === 0 ? (
          <div className="text-sm text-gray-600">No reports yet. Submit your first report from the New Report tab.</div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {reports.map((r) => (
              <div key={r.id} className="border rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold text-sm">{r.category}</div>
                  <div className="text-xs text-gray-500">{new Date(r.createdAt).toLocaleString()}</div>
                </div>
                <div className="text-sm text-gray-700 mb-2 whitespace-pre-line">{r.description}</div>
                <div className="text-xs text-gray-600 mb-2">
                  {r.gps.lat.toFixed(5)}, {r.gps.lon.toFixed(5)} • Blur {r.blurRadius} m
                </div>
                <Timeline status={r.status} />
                {r.media?.length > 0 && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {r.media.slice(0, 3).map((m, i) => (
                      <div key={i} className="h-20 overflow-hidden rounded-lg border">
                        {m.type === "image" && <img src={m.dataUrl} className="w-full h-full object-cover" alt="" />}
                        {m.type === "video" && <video src={m.dataUrl} className="w-full h-full object-cover" />}
                        {m.type === "audio" && <div className="p-1 text-[10px]">Audio: {m.name}</div>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `report_${r.id}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-gray-900 text-white text-xs"
                  >
                    Export JSON
                  </button>
                  <button
                    onClick={() => setSelectedReportId(r.id) || setTab("map")}
                    className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-800 text-xs"
                  >
                    Locate on Map
                  </button>
                  {r.status !== "Resolved" && (
                    <button
                      onClick={() =>
                        setReports((prev) =>
                          prev.map((x) =>
                            x.id === r.id
                              ? {
                                  ...x,
                                  status: x.status === "In Progress" ? "Resolved" : "In Progress",
                                  history: [
                                    ...x.history,
                                    { state: x.status === "In Progress" ? "Resolved" : "In Progress", at: new Date().toISOString() },
                                  ],
                                }
                              : x
                          )
                        )
                      }
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs"
                    >
                      Advance Status
                    </button>
                  )}
                  <button
                    onClick={() => setReports((prev) => prev.filter((x) => x.id !== r.id))}
                    className="px-3 py-1.5 rounded-xl bg-red-600 text-white text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );

  const MapView = () => {
    const selected = reports.find((r) => r.id === selectedReportId) || null;
    const fitPts = useMemo(() => {
      const pts: number[][] = [];
      if (userLoc?.lat && userLoc?.lon) pts.push([userLoc.lat, userLoc.lon]);
      if (selected) {
        const pos = privateView ? [selected.gps.lat, selected.gps.lon] : [selected.publicOffset.lat, selected.publicOffset.lon];
        pts.push(pos as number[]);
      }
      return pts;
    }, [userLoc?.lat, userLoc?.lon, selected?.id, privateView]);

    return (
      <div className="max-w-7xl mx-auto px-3 py-4">
        <Section title="Map & Distance">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-700">
              View: <b>{privateView ? "Private (raw)" : "Public (blurred)"}</b>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPrivateView((v) => !v)} className="px-3 py-1.5 rounded-xl bg-gray-900 text-white">
                Toggle View
              </button>
              <button onClick={captureGps} className="px-3 py-1.5 rounded-xl bg-gray-100">
                Locate Me
              </button>
            </div>
          </div>
          <div className="h-[420px] rounded-xl overflow-hidden border relative">
            <MapContainer
              center={userLoc ? ([userLoc.lat, userLoc.lon] as any) : ([5.556, -0.1969] as any)}
              zoom={12}
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
              {userLoc && (
                <>
                  <Marker position={[userLoc.lat, userLoc.lon] as any} />
                  <Circle center={[userLoc.lat, userLoc.lon] as any} radius={userLoc.accuracy || 20} />
                </>
              )}
              {reports.map((r) => {
                const pos = privateView ? ([r.gps.lat, r.gps.lon] as any) : ([r.publicOffset.lat, r.publicOffset.lon] as any);
                const isSel = r.id === selectedReportId;
                return (
                  <React.Fragment key={r.id}>
                    <Marker position={pos} eventHandlers={{ click: () => setSelectedReportId(r.id) }} />
                    {!privateView && r.blurRadius > 0 && <Circle center={[r.gps.lat, r.gps.lon] as any} radius={r.blurRadius} />}
                    {isSel && fitPts.length > 0 && <FitToBounds points={fitPts} />}
                  </React.Fragment>
                );
              })}
            </MapContainer>
          </div>
          {selected && userLoc && (
            <div className="mt-3 text-sm text-gray-700">
              Selected: <b>{selected.category}</b> • {new Date(selected.createdAt).toLocaleString()}
              <br />
              Distance:{" "}
              <b>
                {(haversine(
                  userLoc.lat,
                  userLoc.lon,
                  privateView ? selected.gps.lat : selected.publicOffset.lat,
                  privateView ? selected.gps.lon : selected.publicOffset.lon
                ) / 1000).toFixed(2)}{" "}
                km
              </b>
            </div>
          )}
        </Section>
      </div>
    );
  };

  const Help = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="Safety & Privacy">
        <SafetyNotes />
        <div className="mt-4 text-sm text-gray-700">
          <p className="mb-2">
            <b>Geo-privacy:</b> In Public view, the exact point is hidden. A pin is placed randomly within your blur circle. Use
            a larger blur in sensitive areas.
          </p>
          <p className="mb-2">
            <b>Offline-first:</b> Reports stay on your phone. This demo has no server. You can export a report as JSON.
          </p>
          <p className="mb-2">
            <b>Manual GPS:</b> If GPS fails, type your latitude and longitude (from another map app) before submitting.
          </p>
        </div>
      </Section>
    </div>
  );

  // ---- Render ----
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      {tab === "report" && <NewReport />}
      {tab === "my" && <MyReports />}
      {tab === "map" && <MapView />}
      {tab === "help" && <Help />}

      <footer className="max-w-7xl mx-auto px-3 py-6 text-xs text-gray-500">
        Demo only • All data stored locally • AAMUSTED project
      </footer>
    </div>
  );
}
