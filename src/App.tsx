import React, { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MapContainer, TileLayer, Marker, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * GALAMWATCH — Safety Upgrade (r8, no-duress)
 * - App PIN lock (no duress)
 * - Quick Hide (Notes) + Quick Wipe (Settings)
 * - "I'm Safe" check-ins + move-away reminder
 * - Auto Blackout cover during capture
 * - Manual photo redaction (pixelate boxes)
 * - AES-GCM Encrypted export + Redacted export
 * - Differential-privacy heatmap with k-anonymity
 * - Auto-expiry cleanup
 * - Learn guide in Settings
 *
 * Zero extra runtime deps. TypeScript + React + Vite + Leaflet.
 */

// ---------- Leaflet marker icon fix ----------
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

// ---------- Utils ----------
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
  }, [map, sig, points.length]);
  return null;
}

// ---------- Storage ----------
const LS_REPORTS = "gw_reports_r8";
const LS_SETTINGS = "gw_settings_r8";
const LS_NOTES = "gw_notes_r8";
const LS_LOCKSTATE = "gw_locked_r8"; // "locked" | "unlocked"
const safeParse = <T,>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ---------- Types ----------
type Media = { type: "image" | "video" | "audio"; name: string; dataUrl: string };
type Contact =
  | {
      shareContact: boolean;
      phone?: string;
      email?: string;
      wantsCallback?: boolean;
      preferredTime?: string;
    }
  | null;
type Report = {
  id: string;
  createdAt: string;
  category: string;
  description: string;
  gps: { lat: number; lon: number; accuracy?: number };
  blurRadius: number;
  publicOffset: { lat: number; lon: number };
  media: Media[];
  contact: Contact;
  status: "Submitted" | "Received" | "In Progress" | "Resolved";
  history: { state: string; at: string }[];
};

// ---------- Settings model ----------
type Settings = {
  autoBlackout: boolean;
  authoritySms: string;
  appPinHash?: string; // SHA-256 hex
  lockMyReports: boolean;
  lockSettings: boolean;
  autoExpiryDays: number; // 0 = off
  dpEpsilon: number; // DP noise for heatmap
  dpKMin: number; // k-anonymity threshold
  encryptPassphrase?: string; // AES-GCM export
};

// ---------- Settings I/O ----------
const defaultSettings: Settings = {
  autoBlackout: true,
  authoritySms: "",
  lockMyReports: true,
  lockSettings: true,
  autoExpiryDays: 0,
  dpEpsilon: 1.0,
  dpKMin: 3,
  encryptPassphrase: "",
};
const loadReports = () =>
  typeof window === "undefined"
    ? []
    : safeParse<Report[]>(localStorage.getItem(LS_REPORTS), []);
const saveReports = (r: Report[]) =>
  localStorage.setItem(LS_REPORTS, JSON.stringify(r));
const loadSettings = () =>
  typeof window === "undefined"
    ? defaultSettings
    : { ...defaultSettings, ...safeParse<Settings>(localStorage.getItem(LS_SETTINGS), defaultSettings) };
const saveSettings = (s: Settings) =>
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
const loadNotes = () =>
  typeof window === "undefined" ? "" : localStorage.getItem(LS_NOTES) || "";
const saveNotes = (t: string) => localStorage.setItem(LS_NOTES, t);
const getLockState = () =>
  typeof window === "undefined" ? "unlocked" : localStorage.getItem(LS_LOCKSTATE) || "unlocked";
const setLockState = (v: "locked" | "unlocked") =>
  localStorage.setItem(LS_LOCKSTATE, v);

// ---------- Crypto helpers ----------
async function sha256Hex(str: string) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function aesEncryptToBase64(plaintext: string, passphrase: string) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("gw-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...out));
}

// ---------- Privacy meter ----------
function privacyLabel(blur: number) {
  if (blur >= 500) return { label: "High", cls: "bg-emerald-100 text-emerald-700" };
  if (blur >= 200) return { label: "Medium", cls: "bg-amber-100 text-amber-700" };
  return { label: "Low", cls: "bg-red-100 text-red-700" };
}

// ---------- App ----------
export default function App() {
  const [tab, setTab] = useState<
    "report" | "my" | "map" | "help" | "settings" | "cover" | "lock"
  >("report");
  const [reports, setReports] = useState<Report[]>(loadReports());
  const [userLoc, setUserLoc] = useState<null | {
    lat: number;
    lon: number;
    accuracy?: number;
  }>(null);
  const [privateView, setPrivateView] = useState(true);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [banner, setBanner] = useState<null | {
    type: "error" | "success" | "info";
    text: string;
  }>(null);
  const [notes, setNotes] = useState<string>(loadNotes());
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [coverReason, setCoverReason] = useState<string | null>(null);
  const [locked, setLocked] = useState(getLockState() === "locked");
  const [showLearn, setShowLearn] = useState<boolean>(false);

  // Uncontrolled inputs (smooth typing)
  const [category, setCategory] = useState<string>("");
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const latRef = useRef<HTMLInputElement | null>(null);
  const lonRef = useRef<HTMLInputElement | null>(null);
  const [gps, setGps] = useState<null | { lat: number; lon: number; accuracy?: number }>(null);
  const [blurRadius, setBlurRadius] = useState<number>(300);
  const [media, setMedia] = useState<Media[]>([]);
  const [sensitiveMode, setSensitiveMode] = useState<boolean>(false);
  const [confirmSafe, setConfirmSafe] = useState<boolean>(false);
  const [confirmNoConfront, setConfirmNoConfront] = useState<boolean>(false);

  // Contact
  const [shareContact, setShareContact] = useState<boolean>(false);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const [wantsCallback, setWantsCallback] = useState<boolean>(false);
  const timeRef = useRef<HTMLInputElement | null>(null);

  // Safety timers/anchors
  const safetyTimerRef = useRef<number | null>(null);
  const [showSafetyBar, setShowSafetyBar] = useState(false);
  const captureAnchorRef = useRef<{ lat: number; lon: number } | null>(null);
  const [moveWarn, setMoveWarn] = useState(false);
  const geoWatchRef = useRef<number | null>(null);

  // Redaction modal
  const [redactIdx, setRedactIdx] = useState<number | null>(null);

  useEffect(() => saveReports(reports), [reports]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveNotes(notes), [notes]);

  // Auto-expiry (on mount)
  useEffect(() => {
    if (!settings.autoExpiryDays || settings.autoExpiryDays <= 0) return;
    const now = Date.now();
    const maxAge = settings.autoExpiryDays * 24 * 60 * 60 * 1000;
    const cleaned = reports.filter((r) => now - new Date(r.createdAt).getTime() <= maxAge);
    if (cleaned.length !== reports.length) setReports(cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock gate
  useEffect(() => {
    if (locked) setTab("lock");
  }, [locked]);

  // Safety timer handling
  const startSafetyTimer = () => {
    setShowSafetyBar(true);
    if (safetyTimerRef.current) window.clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = window.setTimeout(() => {
      setBanner({ type: "info", text: "Safety reminder: move to a safe place if you can." });
    }, 5 * 60 * 1000);
  };
  const stopSafetyTimer = () => {
    setShowSafetyBar(false);
    if (safetyTimerRef.current) {
      window.clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  };

  // Move-away monitoring
  const beginMoveMonitor = (anchor: { lat: number; lon: number }) => {
    captureAnchorRef.current = anchor;
    setMoveWarn(false);
    if (!navigator.geolocation) return;
    if (geoWatchRef.current && (navigator.geolocation as any).clearWatch) {
      (navigator.geolocation as any).clearWatch(geoWatchRef.current);
      geoWatchRef.current = null;
    }
    geoWatchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const d = haversine(anchor.lat, anchor.lon, pos.coords.latitude, pos.coords.longitude);
        if (d < 300 && showSafetyBar === false) setMoveWarn(true);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    ) as unknown as number;
  };
  const endMoveMonitor = () => {
    captureAnchorRef.current = null;
    setMoveWarn(false);
    if (geoWatchRef.current && (navigator.geolocation as any).clearWatch) {
      (navigator.geolocation as any).clearWatch(geoWatchRef.current);
      geoWatchRef.current = null;
    }
  };

  // GPS capture
  const captureGps = () => {
    if (!navigator.geolocation) {
      setBanner({ type: "error", text: "Geolocation not supported on this device." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setUserLoc(d);
        setGps(d);
        startSafetyTimer();
        beginMoveMonitor({ lat: d.lat, lon: d.lon });
      },
      () =>
        setBanner({
          type: "error",
          text: "Could not get GPS. Check permission/location settings.",
        }),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
    );
  };

  // Auto Blackout
  type CaptureKind = "image" | "video" | "audio";
  const handleCaptureStart = (kind: CaptureKind) => {
    if (!settings.autoBlackout) return;
    const msg =
      kind === "image"
        ? "Opening camera..."
        : kind === "video"
        ? "Opening video recorder..."
        : "Opening audio recorder...";
    setCoverReason(msg);
    setTab("cover");
  };
  const handleCaptureFinish = () => {
    if (!settings.autoBlackout) return;
    setTimeout(() => {
      setCoverReason(null);
      setTab("report");
    }, 300);
  };

  // Files & media
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: Media["type"]) => {
    const f = e.target.files?.[0];
    if (!f) {
      handleCaptureFinish();
      return;
    }
    try {
      const dataUrl =
        type === "image"
          ? await sanitizeImage(f) // EXIF strip
          : await new Promise<string>((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result as string);
              fr.onerror = rej;
              fr.readAsDataURL(f);
            });
      setMedia((prev) => [...prev, { type, name: f.name, dataUrl }]);
      setBanner({
        type: "success",
        text: `${type === "image" ? "Photo" : type === "video" ? "Video" : "Audio"} attached.`,
      });
      startSafetyTimer();
      if (gps) beginMoveMonitor({ lat: gps.lat, lon: gps.lon });
    } catch {
      setBanner({ type: "error", text: "Could not process file." });
    } finally {
      e.target.value = "";
      handleCaptureFinish();
    }
  };
  const removeMedia = (i: number) =>
    setMedia((prev) => prev.filter((_, idx) => idx !== i));

  // Manual redaction modal for images
  const RedactModal: React.FC<{ idx: number }> = ({ idx }) => {
    const m = media[idx];
    const [rects, setRects] = useState<{ x: number; y: number; w: number; h: number }[]>([]);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const [drag, setDrag] = useState<{
      startX: number;
      startY: number;
      x: number;
      y: number;
      dragging: boolean;
    }>({ startX: 0, startY: 0, x: 0, y: 0, dragging: false });

    useEffect(() => {
      const img = new Image();
      img.src = m.dataUrl;
      img.onload = () => {
        imgRef.current = img;
        const c = canvasRef.current!;
        const ctx = c.getContext("2d")!;
        const maxW = Math.min(900, window.innerWidth - 40);
        const scale = Math.min(1, maxW / img.width);
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        ctx.drawImage(img, 0, 0, c.width, c.height);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idx]);

    const redraw = () => {
      const c = canvasRef.current!;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(imgRef.current!, 0, 0, c.width, c.height);
      ctx.save();
      ctx.strokeStyle = "rgba(255,0,0,0.8)";
      ctx.lineWidth = 2;
      rects.forEach((r) => {
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      });
      if (drag.dragging) {
        ctx.strokeRect(drag.startX, drag.startY, drag.x - drag.startX, drag.y - drag.startY);
      }
      ctx.restore();
    };

    const onDown = (e: React.MouseEvent) => {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      setDrag({
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        x: 0,
        y: 0,
        dragging: true,
      });
    };
    const onMove = (e: React.MouseEvent) => {
      if (!drag.dragging) return;
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      setDrag((prev) => ({ ...prev, x: e.clientX - rect.left, y: e.clientY - rect.top }));
      redraw();
    };
    const onUp = () => {
      if (!drag.dragging) return;
      const w = drag.x - drag.startX,
        h = drag.y - drag.startY;
      const norm = {
        x: Math.min(drag.startX, drag.x),
        y: Math.min(drag.startY, drag.y),
        w: Math.abs(w),
        h: Math.abs(h),
      };
      if (norm.w > 6 && norm.h > 6) setRects((prev) => [...prev, norm]);
      setDrag({ startX: 0, startY: 0, x: 0, y: 0, dragging: false });
      redraw();
    };

    useEffect(() => {
      if (canvasRef.current && imgRef.current) redraw();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rects]);

    const applyPixelate = () => {
      const c = canvasRef.current!;
      const ctx = c.getContext("2d")!;
      rects.forEach((r) => {
        const block = 8;
        const temp = document.createElement("canvas");
        const tctx = temp.getContext("2d")!;
        temp.width = Math.ceil(r.w / block);
        temp.height = Math.ceil(r.h / block);
        tctx.drawImage(c, r.x, r.y, r.w, r.h, 0, 0, temp.width, temp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(temp, 0, 0, temp.width, temp.height, r.x, r.y, r.w, r.h);
      });
      const dataUrl = c.toDataURL("image/jpeg", 0.9);
      const newMedia = [...media];
      newMedia[idx] = { ...newMedia[idx], dataUrl };
      setMedia(newMedia);
      setRedactIdx(null);
      setBanner({ type: "success", text: "Redaction applied." });
    };

    return (
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-3">
        <div className="bg-white rounded-2xl shadow max-w-[96vw] w-full p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Redact image</div>
            <button onClick={() => setRedactIdx(null)} className="px-3 py-1.5 rounded bg-gray-100">
              Close
            </button>
          </div>
          <div className="text-xs text-gray-600 mb-2">
            Drag to draw boxes over faces/plates. Click "Apply" to pixelate those regions.
          </div>
          <div className="overflow-auto">
            <canvas
              ref={canvasRef}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={onUp}
              className="border rounded w-full"
            />
          </div>
          <div className="mt-3 flex gap-2 justify-end">
            <button onClick={() => setRects([])} className="px-3 py-1.5 rounded bg-gray-100">
              Clear boxes
            </button>
            <button
              onClick={applyPixelate}
              className="px-3 py-1.5 rounded bg-emerald-600 text-white"
            >
              Apply redaction
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Submit
  const submitReport = () => {
    setBanner(null);
    if (!confirmSafe || !confirmNoConfront) {
      setBanner({
        type: "error",
        text: "Please confirm you are at a safe distance and will not confront anyone.",
      });
      return;
    }
    const description = (descRef.current?.value || "").trim();
    if (!description) {
      setBanner({ type: "error", text: "Please add a short description." });
      return;
    }

    let useGps = gps;
    const lat = Number(latRef.current?.value || "");
    const lon = Number(lonRef.current?.value || "");
    const latOk = isFinite(lat) && lat >= -90 && lat <= 90;
    const lonOk = isFinite(lon) && lon >= -180 && lon <= 180;
    if (!useGps && latOk && lonOk) useGps = { lat, lon };

    if (!useGps) {
      setBanner({
        type: "error",
        text: "Tap Use My Location or enter latitude and longitude.",
      });
      return;
    }

    // Contact validation
    let contact: Contact = null;
    if (shareContact) {
      const phone = (phoneRef.current?.value || "").trim();
      const email = (emailRef.current?.value || "").trim();
      const preferredTime = (timeRef.current?.value || "").trim();
      if (wantsCallback && !phone && !email) {
        setBanner({
          type: "error",
          text: "To request a callback, enter a phone number or an email.",
        });
        return;
      }
      contact = {
        shareContact: true,
        phone: phone || undefined,
        email: email || undefined,
        wantsCallback,
        preferredTime: preferredTime || undefined,
      };
    }

    const minBlur = sensitiveMode ? 500 : 0;
    const chosenBlur = Math.max(minBlur, clamp(Number(blurRadius || 0), 0, 2000));
    const offset =
      chosenBlur > 0
        ? randomPointInRing(
            useGps.lat,
            useGps.lon,
            Math.max(1, chosenBlur * 0.5),
            chosenBlur
          )
        : { lat: useGps.lat, lon: useGps.lon };

    const nowIso = new Date().toISOString();
    const report: Report = {
      id: uuidv4(),
      createdAt: nowIso,
      category: category || "Unspecified",
      description,
      gps: useGps,
      blurRadius: chosenBlur,
      publicOffset: offset,
      media,
      contact,
      status: "Submitted",
      history: [{ state: "Submitted", at: nowIso }],
    };
    setReports((prev) => [report, ...prev]);

    // reset
    setCategory("");
    if (descRef.current) descRef.current.value = "";
    if (latRef.current) latRef.current.value = "";
    if (lonRef.current) lonRef.current.value = "";
    if (phoneRef.current) phoneRef.current.value = "";
    if (emailRef.current) emailRef.current.value = "";
    if (timeRef.current) timeRef.current.value = "";
    setGps(null);
    setBlurRadius(sensitiveMode ? 500 : 300);
    setMedia([]);
    setConfirmSafe(false);
    setConfirmNoConfront(false);
    setShareContact(false);
    setWantsCallback(false);
    stopSafetyTimer();
    endMoveMonitor();

    setBanner({ type: "success", text: "Report submitted. Track it in My Reports." });
    setTimeout(() => {
      setReports((prev) =>
        prev.map((x) =>
          x.id === report.id
            ? {
                ...x,
                status: "Received",
                history: [...x.history, { state: "Received", at: new Date().toISOString() }],
              }
            : x
        )
      );
    }, 900);
    setTab("my");
  };

  // SMS helpers
  const buildSmsText = (r: Report) => {
    const when = new Date(r.createdAt).toLocaleString();
    const acc = Math.round(r.gps.accuracy || 0);
    const coords = `${r.gps.lat.toFixed(5)}, ${r.gps.lon.toFixed(5)} (±${acc} m)`;
    const desc = (r.description || "").replace(/\s+/g, " ").slice(0, 300);
    const cb = r.contact?.shareContact
      ? `\nCallback: ${r.contact?.wantsCallback ? "YES" : "no"}${r.contact?.phone ? `, Phone: ${r.contact.phone}` : ""}${r.contact?.email ? `, Email: ${r.contact.email}` : ""}${r.contact?.preferredTime ? `, Time: ${r.contact.preferredTime}` : ""}`
      : "";
    return `Galamsey Report
Category: ${r.category}
When: ${when}
GPS: ${coords}
Blur radius: ${r.blurRadius} m (public map is obfuscated)
Details: ${desc}${cb}`;
  };
  const copyToClipboard = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      setBanner({ type: "success", text: "Text copied. Paste in Messages." });
    } catch {
      setBanner({
        type: "info",
        text: "Copy failed. Long-press to select and copy from the dialog.",
      });
      window.prompt("Copy text below:", txt);
    }
  };
  const openSmsDraft = (r: Report) => {
    if (!settings.authoritySms) {
      setBanner({ type: "error", text: "Add an authority SMS number in Settings first." });
      return;
    }
    const body = encodeURIComponent(buildSmsText(r));
    const to = encodeURIComponent(settings.authoritySms);
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const link = isiOS ? `sms:${to}&body=${body}` : `sms:${to}?body=${body}`;
    try {
      window.location.href = link;
    } catch {
      copyToClipboard(buildSmsText(r));
    }
  };

  // Export helpers
  const redactedClone = (r: Report) => ({
    ...r,
    contact: null,
    media: [],
    gps: r.gps,
    publicOffset: r.publicOffset,
    blurRadius: r.blurRadius,
  });
  const exportJSON = (obj: any, name: string) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Emergency dial
  const emergencyDial = () => {
    const ok = window.confirm("Call emergency services (112)?");
    if (ok) window.location.href = "tel:112";
  };

  // App Lock + Quick Wipe
  const [pinInput, setPinInput] = useState("");
  const lockIfNeeded = (dest: typeof tab) => {
    if ((dest === "my" && settings.lockMyReports) || (dest === "settings" && settings.lockSettings)) {
      setLockState("locked");
      setLocked(true);
      setTab("lock");
    } else setTab(dest);
  };
  const tryUnlock = async () => {
    const hash = await sha256Hex(pinInput);
    if (settings.appPinHash && hash === settings.appPinHash) {
      setLockState("unlocked");
      setLocked(false);
      setPinInput("");
      setTab("report");
      setBanner({ type: "success", text: "Unlocked." });
    } else {
      setBanner({ type: "error", text: "Wrong PIN." });
    }
  };
  const quickWipe = async () => {
    try {
      localStorage.removeItem(LS_REPORTS);
      localStorage.removeItem(LS_SETTINGS);
      localStorage.removeItem(LS_NOTES);
      localStorage.removeItem(LS_LOCKSTATE);
      try {
        indexedDB.deleteDatabase("galamwatch");
      } catch {}
      try {
        indexedDB.deleteDatabase("gw-db");
      } catch {}
      try {
        indexedDB.deleteDatabase("keyval-store");
      } catch {}
    } catch {}
    setReports([]);
    setNotes("");
    setSettings(defaultSettings);
    setLockState("unlocked");
    setLocked(false);
    setTab("cover");
    setCoverReason("Notes");
    setBanner({ type: "info", text: "Local data cleared." });
  };

  // UI atoms
  const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
    title,
    children,
  }) => (
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
            <div
              className={`px-2 py-1 rounded ${
                steps.indexOf(status) >= idx
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {s}
            </div>
            {idx < steps.length - 1 && <div className="h-px w-6 bg-gray-300" />}
          </div>
        ))}
      </div>
    );
  };

  // Header
  const Header = () => (
    <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-base sm:text-lg">
            {tab === "cover" ? "Notes" : "Galamwatch"}
          </span>
          <span className="hidden sm:inline text-xs text-gray-500">
            {tab === "cover" ? (coverReason ? "Cover active" : "Personal notes") : "Privacy-first reporting"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {tab !== "cover" ? (
            <>
              <button
                onClick={() => setTab("cover")}
                className="text-sm px-3 py-1.5 rounded-xl bg-gray-100"
                title="Switch to Notes cover"
              >
                Quick Hide
              </button>
              <button
                onClick={emergencyDial}
                className="text-sm px-3 py-1.5 rounded-xl bg-red-600 text-white"
              >
                Emergency 112
              </button>
            </>
          ) : (
            <button
              onClick={() => setTab("report")}
              className="text-sm px-3 py-1.5 rounded-xl bg-gray-900 text-white"
            >
              Back
            </button>
          )}
        </div>
      </div>
      {tab !== "cover" && (
        <nav className="max-w-7xl mx-auto px-3 flex gap-1 pb-2 flex-wrap">
          {[
            { k: "report", label: "New Report" },
            { k: "my", label: "My Reports" },
            { k: "map", label: "Map" },
            { k: "help", label: "Help" },
            { k: "settings", label: "Settings" },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => lockIfNeeded(t.k as any)}
              className={`px-3 py-1.5 rounded-xl text-sm ${
                tab === (t.k as any) ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );

  // New Report
  const NewReport = () => {
    const selectedBlur = sensitiveMode ? Math.max(500, blurRadius) : blurRadius;
    const meter = privacyLabel(selectedBlur);

    return (
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

        {showSafetyBar && (
          <div className="mb-3 rounded-xl bg-amber-50 text-amber-800 px-3 py-2 text-sm flex items-center justify-between">
            <div>Safety check: move away from the capture area and confirm.</div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  stopSafetyTimer();
                  endMoveMonitor();
                  setBanner({ type: "success", text: "Glad you are safe." });
                }}
                className="px-2 py-1 rounded bg-amber-100"
              >
                I am safe
              </button>
              <button
                onClick={() => {
                  stopSafetyTimer();
                  setTimeout(startSafetyTimer, 5 * 60 * 1000);
                }}
                className="px-2 py-1 rounded bg-amber-100"
              >
                Remind in 5m
              </button>
            </div>
          </div>
        )}
        {moveWarn && (
          <div className="mb-3 rounded-xl bg-red-50 text-red-700 px-3 py-2 text-sm">
            You may be too close to the capture location. Consider moving to a safer place.
          </div>
        )}

        <Section title="Reporting Form">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="cat" className="block text-sm font-medium">
                Category
              </label>
              <select
                id="cat"
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Select (optional)</option>
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
                {gps ? (
                  <span className="text-sm text-gray-700">
                    {gps.lat.toFixed(5)}, {gps.lon.toFixed(5)} • ±{Math.round(gps.accuracy || 0)} m
                  </span>
                ) : (
                  <span className="text-sm text-gray-500">No location yet</span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  id="lat"
                  ref={latRef}
                  inputMode="decimal"
                  className="rounded-xl border px-3 py-2 text-sm"
                  placeholder="Latitude (e.g., 5.6037)"
                />
                <input
                  id="lon"
                  ref={lonRef}
                  inputMode="decimal"
                  className="rounded-xl border px-3 py-2 text-sm"
                  placeholder="Longitude (e.g., -0.1870)"
                />
              </div>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="desc" className="block text-sm font-medium">
                Description
              </label>
              <textarea
                id="desc"
                ref={descRef}
                className="mt-1 w-full rounded-xl border px-3 py-2 min-h-[110px]"
                placeholder="What did you see? When? Any landmarks?"
              />
            </div>
          </div>

          {/* Safety confirmations */}
          <div className="mt-4 grid sm:grid-cols-2 gap-4">
            <label htmlFor="safe" className="flex items-center gap-2 text-sm">
              <input
                id="safe"
                type="checkbox"
                checked={confirmSafe}
                onChange={(e) => setConfirmSafe(e.target.checked)}
              />
              I am at a safe distance.
            </label>
            <label htmlFor="nocon" className="flex items-center gap-2 text-sm">
              <input
                id="nocon"
                type="checkbox"
                checked={confirmNoConfront}
                onChange={(e) => setConfirmNoConfront(e.target.checked)}
              />
              I will not confront anyone.
            </label>
          </div>

          {/* Sensitive Mode + Privacy meter */}
          <div className="mt-4 grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="sens" className="block text-sm font-medium">
                Sensitive Location Mode
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="sens"
                  type="checkbox"
                  checked={sensitiveMode}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setSensitiveMode(on);
                    if (on && blurRadius < 500) setBlurRadius(500);
                  }}
                />
                Treat as sensitive (homes, schools, water). Enforces minimum blur of 500 m.
              </label>
            </div>
            <div className="flex items-end justify-end">
              <span className={`px-2 py-1 rounded text-xs ${meter.cls}`}>
                Privacy level: {meter.label}
              </span>
            </div>
          </div>

          {/* Media + Redaction */}
          <div className="mt-4 grid sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="photo" className="block text-sm font-medium">
                Add Photo
              </label>
              <input
                id="photo"
                type="file"
                accept="image/*"
                capture="environment"
                onClick={() => handleCaptureStart("image")}
                onChange={(e) => onFileChange(e, "image")}
              />
            </div>
            <div>
              <label htmlFor="video" className="block text-sm font-medium">
                Add Video
              </label>
              <input
                id="video"
                type="file"
                accept="video/*"
                capture="environment"
                onClick={() => handleCaptureStart("video")}
                onChange={(e) => onFileChange(e, "video")}
              />
            </div>
            <div>
              <label htmlFor="audio" className="block text-sm font-medium">
                Add Voice Note
              </label>
              <input
                id="audio"
                type="file"
                accept="audio/*"
                onClick={() => handleCaptureStart("audio")}
                onChange={(e) => onFileChange(e, "audio")}
              />
            </div>
          </div>
          {media.length > 0 && (
            <div className="mt-3 grid sm:grid-cols-3 gap-3">
              {media.map((m, i) => (
                <div key={i} className="border rounded-xl p-2">
                  <div className="text-xs text-gray-500 mb-1">
                    {m.type} • {m.name}
                  </div>
                  {m.type === "image" && (
                    <img src={m.dataUrl} className="w-full h-36 object-cover rounded-lg" alt="" />
                  )}
                  {m.type === "video" && (
                    <video src={m.dataUrl} className="w-full rounded-lg" controls />
                  )}
                  {m.type === "audio" && <audio src={m.dataUrl} className="w-full" controls />}
                  <div className="mt-2 flex justify-between">
                    {m.type === "image" ? (
                      <button onClick={() => setRedactIdx(i)} className="text-xs text-blue-600">
                        Edit/Redact
                      </button>
                    ) : (
                      <span />
                    )}
                    <button onClick={() => removeMedia(i)} className="text-xs text-red-600">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-xs text-gray-600">
            Images remove EXIF metadata automatically. Use "Edit/Redact" to blur faces/plates.
          </div>

          {/* Geo-Privacy */}
          <div className="mt-4">
            <label htmlFor="blur" className="block text-sm font-medium">
              Geo-Privacy Blur Radius (meters)
            </label>
            <input
              id="blur"
              type="range"
              min={sensitiveMode ? 500 : 0}
              max={2000}
              step={50}
              value={selectedBlur}
              onChange={(e) => setBlurRadius(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between text-sm text-gray-600">
              <div className="flex gap-2">
                {(sensitiveMode ? [500, 700, 1000, 1500, 2000] : [0, 100, 300, 500, 1000, 2000]).map(
                  (m) => (
                    <button
                      key={m}
                      onClick={() => setBlurRadius(m)}
                      className="px-2 py-1 rounded bg-gray-100"
                    >
                      {m}m
                    </button>
                  )
                )}
              </div>
              <span>
                Selected: <b>{selectedBlur} m</b>
              </span>
            </div>
            <p className="mt-2 text-xs text-gray-600">
              Public maps never show your exact point. The public pin is randomly placed inside your
              blur circle. Use larger blur in sensitive areas.
            </p>
          </div>

          {/* Contact & Callback */}
          <div className="mt-6 border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">Contact & Callback (optional)</h3>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={shareContact}
                onChange={(e) => setShareContact(e.target.checked)}
              />{" "}
              Share contact for follow-up
            </label>
            {shareContact && (
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <input
                  ref={phoneRef}
                  className="rounded-xl border px-3 py-2"
                  placeholder="Phone (optional)"
                  inputMode="tel"
                />
                <input
                  ref={emailRef}
                  className="rounded-xl border px-3 py-2"
                  placeholder="Email (optional)"
                  inputMode="email"
                />
                <label className="flex items-center gap-2 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={wantsCallback}
                    onChange={(e) => setWantsCallback(e.target.checked)}
                  />{" "}
                  Request a callback from authorities
                </label>
                <input
                  ref={timeRef}
                  className="rounded-xl border px-3 py-2 sm:col-span-2"
                  placeholder="Preferred time (e.g., 16:00-18:00)"
                />
                <p className="sm:col-span-2 text-xs text-gray-500">
                  Contact stays on your device in this demo. Exported JSON will include it if you
                  choose full export.
                </p>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex items-center justify-between">
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
              <li>Keep a safe distance. Do not confront anyone.</li>
              <li>Use Sensitive Mode near homes, schools, or water.</li>
              <li>Capture landmarks (bridge, bend) not faces/plates.</li>
            </ul>
            <div className="flex gap-2">
              <button
                onClick={submitReport}
                className={`px-4 py-2 rounded-xl text-white ${
                  confirmSafe && confirmNoConfront
                    ? "bg-emerald-600"
                    : "bg-gray-400 cursor-not-allowed"
                }`}
                disabled={!confirmSafe || !confirmNoConfront}
              >
                Submit Report
              </button>
            </div>
          </div>
        </Section>
        {redactIdx !== null && <RedactModal idx={redactIdx} />}
      </div>
    );
  };

  // My Reports
  const MyReports = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="My Reports">
        {reports.length === 0 ? (
          <div className="text-sm text-gray-600">
            No reports yet. Submit your first report from the New Report tab.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {reports.map((r) => (
              <div key={r.id} className="border rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold text-sm">{r.category}</div>
                  <div className="text-xs text-gray-500">{new Date(r.createdAt).toLocaleString()}</div>
                </div>
                <div className="text-sm text-gray-700 mb-2 whitespace-pre-line">
                  {r.description}
                </div>
                <div className="text-xs text-gray-600 mb-2">
                  {r.gps.lat.toFixed(5)}, {r.gps.lon.toFixed(5)} • Blur {r.blurRadius} m
                </div>
                {r.contact?.shareContact && (
                  <div className="mb-2 text-xs">
                    <span className="inline-block px-2 py-0.5 rounded bg-blue-50 text-blue-700 mr-2">
                      Contact Shared
                    </span>
                    {r.contact?.wantsCallback && (
                      <span className="inline-block px-2 py-0.5 rounded bg-amber-50 text-amber-700">
                        Callback requested
                      </span>
                    )}
                    <div className="mt-1 text-gray-700">
                      {r.contact?.phone && <div>Phone: {r.contact.phone}</div>}
                      {r.contact?.email && <div>Email: {r.contact.email}</div>}
                      {r.contact?.preferredTime && (
                        <div>Preferred time: {r.contact.preferredTime}</div>
                      )}
                    </div>
                  </div>
                )}
                <div className="mb-2">
                  <Timeline status={r.status} />
                </div>
                {r.media?.length > 0 && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {r.media.slice(0, 3).map((m, i) => (
                      <div key={i} className="h-20 overflow-hidden rounded-lg border">
                        {m.type === "image" && (
                          <img src={m.dataUrl} className="w-full h-full object-cover" alt="" />
                        )}
                        {m.type === "video" && (
                          <video src={m.dataUrl} className="w-full h-full object-cover" />
                        )}
                        {m.type === "audio" && (
                          <div className="p-1 text-[10px]">Audio: {m.name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => exportJSON(r, `report_${r.id}.json`)}
                    className="px-3 py-1.5 rounded-xl bg-gray-900 text-white text-xs"
                  >
                    Export JSON
                  </button>
                  <button
                    onClick={() => exportJSON(redactedClone(r), `report_${r.id}_redacted.json`)}
                    className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-800 text-xs"
                  >
                    Export Redacted
                  </button>
                  <button
                    onClick={async () => {
                      if (!settings.encryptPassphrase) {
                        setBanner({
                          type: "error",
                          text: "Set an encryption passphrase in Settings first.",
                        });
                        return;
                      }
                      const ct = await aesEncryptToBase64(
                        JSON.stringify(r),
                        settings.encryptPassphrase
                      );
                      exportJSON(
                        { encrypted: true, alg: "AES-GCM", payload_b64: ct },
                        `report_${r.id}_encrypted.json`
                      );
                    }}
                    className="px-3 py-1.5 rounded-xl bg-purple-600 text-white text-xs"
                  >
                    Export Encrypted
                  </button>
                  <button
                    onClick={() => {
                      setSelectedReportId(r.id);
                      setTab("map");
                    }}
                    className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-800 text-xs"
                  >
                    Locate on Map
                  </button>
                  <button
                    onClick={() => openSmsDraft(r)}
                    className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs"
                  >
                    SMS Draft
                  </button>
                  <button
                    onClick={() => copyToClipboard(buildSmsText(r))}
                    className="px-3 py-1.5 rounded-xl bg-blue-100 text-blue-700 text-xs"
                  >
                    Copy SMS Text
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
                                    {
                                      state:
                                        x.status === "In Progress" ? "Resolved" : "In Progress",
                                      at: new Date().toISOString(),
                                    },
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

  // Differential Privacy / Heatmap utilities
  function dpNoisy(count: number, epsilon: number) {
    // Simple Laplace mechanism: scale = 1/epsilon
    const u = Math.random() - 0.5;
    return Math.round(count - (1 / epsilon) * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)));
  }

  const MapView = () => {
    const [heat, setHeat] = useState<boolean>(true);
    const selected = reports.find((r) => r.id === selectedReportId) || null;

    const fitPts = useMemo(() => {
      const pts: number[][] = [];
      if (userLoc?.lat && userLoc?.lon) pts.push([userLoc.lat, userLoc.lon]);
      if (selected) {
        const pos = privateView
          ? [selected.gps.lat, selected.gps.lon]
          : [selected.publicOffset.lat, selected.publicOffset.lon];
        pts.push(pos as number[]);
      }
      return pts;
    }, [userLoc?.lat, userLoc?.lon, selected?.id, privateView]);

    const grid = useMemo(() => {
      if (privateView || !heat) return [];
      const cell = 0.01; // approx 1.1km in latitude
      const map = new Map<string, number>();
      reports.forEach((r) => {
        const lat = r.publicOffset.lat,
          lon = r.publicOffset.lon;
        const ky = `${Math.round(lat / cell) * cell},${Math.round(lon / cell) * cell}`;
        map.set(ky, (map.get(ky) || 0) + 1);
      });
      const arr: { lat: number; lon: number; noisy: number }[] = [];
      map.forEach((count, key) => {
        const [la, lo] = key.split(",").map(Number);
        const noisy = dpNoisy(count, settings.dpEpsilon || 1.0);
        if (noisy >= (settings.dpKMin || 3)) arr.push({ lat: la, lon: lo, noisy });
      });
      return arr;
    }, [reports, privateView, heat, settings.dpEpsilon, settings.dpKMin]);

    return (
      <div className="max-w-7xl mx-auto px-3 py-4">
        <Section title="Map & Distance">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-700">
              View: <b>{privateView ? "Private (raw)" : "Public (blurred)"}</b>
            </div>
            <div className="flex gap-2">
              {!privateView && (
                <label className="text-sm flex items-center gap-2 bg-gray-100 px-2 py-1.5 rounded-xl">
                  <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} />{" "}
                  Heatmap
                </label>
              )}
              <button
                onClick={() => setPrivateView((v) => !v)}
                className="px-3 py-1.5 rounded-xl bg-gray-900 text-white"
              >
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
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="© OpenStreetMap"
              />
              {userLoc && (
                <>
                  <Marker position={[userLoc.lat, userLoc.lon] as any} />
                  <Circle center={[userLoc.lat, userLoc.lon] as any} radius={userLoc.accuracy || 20} />
                </>
              )}
              {reports.map((r) => {
                const pos = privateView
                  ? ([r.gps.lat, r.gps.lon] as any)
                  : ([r.publicOffset.lat, r.publicOffset.lon] as any);
                const isSel = r.id === selectedReportId;
                return (
                  <React.Fragment key={r.id}>
                    <Marker position={pos} eventHandlers={{ click: () => setSelectedReportId(r.id) }} />
                    {!privateView && r.blurRadius > 0 && (
                      <Circle center={[r.gps.lat, r.gps.lon] as any} radius={r.blurRadius} />
                    )}
                    {isSel && fitPts.length > 0 && <FitToBounds points={fitPts} />}
                  </React.Fragment>
                );
              })}
              {!privateView &&
                heat &&
                grid.map((g, i) => (
                  <Circle
                    key={i}
                    center={[g.lat, g.lon] as any}
                    radius={Math.min(1200, 300 + g.noisy * 150)}
                    pathOptions={{ color: "#0ea5e9", weight: 1, fillOpacity: 0.2 }}
                  />
                ))}
            </MapContainer>
          </div>
          {selected && userLoc && (
            <div className="mt-3 text-sm text-gray-700">
              Selected: <b>{selected.category}</b> • {new Date(selected.createdAt).toLocaleString()}
              <br />
              Distance:{" "}
              <b>
                {(
                  haversine(
                    userLoc.lat,
                    userLoc.lon,
                    privateView ? selected.gps.lat : selected.publicOffset.lat,
                    privateView ? selected.gps.lon : selected.publicOffset.lon
                  ) / 1000
                ).toFixed(2)}{" "}
                km
              </b>
            </div>
          )}
        </Section>
      </div>
    );
  };

  // Help
  const Help = () => (
    <div className="max-w-7xl mx-auto px-3 py-4">
      <Section title="Safety & Privacy">
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>Keep a safe distance. Never confront anyone.</li>
          <li>Use Sensitive Mode near homes, schools, or water sources.</li>
          <li>Use larger blur for safety; 500 m and above improves privacy.</li>
          <li>Use Edit/Redact to blur faces/plates before exporting/sending.</li>
        </ul>
        <div className="mt-4 flex items-center gap-2">
          <button onClick={emergencyDial} className="px-4 py-2 rounded-xl bg-red-600 text-white">
            Emergency 112
          </button>
        </div>
      </Section>
    </div>
  );

  // Settings (+ Learn)
  const Settings = () => {
    const [pin, setPin] = useState("");
    return (
      <div className="max-w-3xl mx-auto px-3 py-4">
        <Section title="Security">
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.lockMyReports}
                onChange={(e) => setSettings({ ...settings, lockMyReports: e.target.checked })}
              />{" "}
              Lock "My Reports"
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.lockSettings}
                onChange={(e) => setSettings({ ...settings, lockSettings: e.target.checked })}
              />{" "}
              Lock "Settings"
            </label>
            <div className="sm:col-span-2 grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium">Set/Change App PIN</label>
                <input
                  className="mt-1 w-full rounded-xl border px-3 py-2"
                  placeholder="4–6 digits"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  inputMode="numeric"
                />
                <button
                  className="mt-2 px-3 py-1.5 rounded bg-gray-900 text-white text-xs"
                  onClick={async () => {
                    if (!pin) return;
                    const h = await sha256Hex(pin);
                    setSettings({ ...settings, appPinHash: h });
                    setPin("");
                    setBanner({ type: "success", text: "PIN saved." });
                  }}
                >
                  Save PIN
                </button>
              </div>
              <div>
                <label className="block text-sm font-medium">Quick Wipe</label>
                <button
                  onClick={quickWipe}
                  className="mt-1 px-3 py-1.5 rounded bg-red-600 text-white text-xs"
                >
                  Clear local data
                </button>
                <div className="text-xs text-gray-500 mt-1">
                  Removes reports, settings, notes from this device only.
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Authority & Exports">
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-sm font-medium">Authority SMS Number</label>
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2"
                placeholder="e.g., 190 or +233XXXXXXXXX"
                value={settings.authoritySms}
                onChange={(e) => setSettings({ ...settings, authoritySms: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Encryption passphrase (AES-GCM)</label>
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2"
                placeholder="Set to enable encrypted export"
                value={settings.encryptPassphrase || ""}
                onChange={(e) => setSettings({ ...settings, encryptPassphrase: e.target.value })}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-600">
            "Export Encrypted" uses your passphrase to encrypt JSON locally (AES-GCM). Share
            passphrase securely with the authority.
          </p>
        </Section>

        <Section title="Privacy & Cleanup">
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.autoBlackout}
                onChange={(e) => setSettings({ ...settings, autoBlackout: e.target.checked })}
              />{" "}
              Auto Blackout during capture (switch to Notes cover)
            </label>
            <div>
              <label className="block text-sm font-medium">Auto-expire after (days)</label>
              <input
                type="number"
                min={0}
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={settings.autoExpiryDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoExpiryDays: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
              <div className="text-xs text-gray-500 mt-1">0 = off. Old reports are removed at next app start.</div>
            </div>
            <div>
              <label className="block text-sm font-medium">DP epsilon (heatmap noise)</label>
              <input
                type="number"
                step="0.1"
                min={0.1}
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={settings.dpEpsilon}
                onChange={(e) =>
                  setSettings({ ...settings, dpEpsilon: Math.max(0.1, Number(e.target.value) || 1) })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-medium">DP k-anonymity (min cells)</label>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-xl border px-3 py-2"
                value={settings.dpKMin}
                onChange={(e) =>
                  setSettings({ ...settings, dpKMin: Math.max(1, Number(e.target.value) || 3) })
                }
              />
            </div>
          </div>
        </Section>

        <Section title="Learn: How to use the app">
          <button
            onClick={() => setShowLearn((v) => !v)}
            className="px-3 py-1.5 rounded bg-gray-900 text-white text-sm"
          >
            {showLearn ? "Hide guide" : "Open guide"}
          </button>
          {showLearn && (
            <div className="mt-3 text-sm text-gray-700 space-y-2">
              <p>
                <b>1) New Report:</b> Tap <i>Use My Location</i>, add a short description (landmarks
                not faces), attach media, confirm safety, then Submit.
              </p>
              <p>
                <b>2) Geo-privacy:</b> Use the blur slider (&gt;= 500 m in sensitive areas).
                Public maps never show exact points.
              </p>
              <p>
                <b>3) Redaction:</b> After attaching a photo, tap <i>Edit/Redact</i> to draw blur
                boxes over faces/plates. Apply before exporting.
              </p>
              <p>
                <b>4) Safety tools:</b> Use Quick Hide, the "I am safe" bar, and move away from
                capture spots when possible.
              </p>
              <p>
                <b>5) SMS:</b> Set an authority number in Settings. In My Reports -&gt; tap{" "}
                <i>SMS Draft</i> (or Copy SMS Text).
              </p>
              <p>
                <b>6) App PIN:</b> Set an App PIN to lock My Reports/Settings (no duress mode).
              </p>
              <p>
                <b>7) Encrypted export:</b> Set a passphrase; use <i>Export Encrypted</i> to share a
                protected JSON.
              </p>
              <p className="text-xs text-gray-500">
                This demo stores data on your device only. For live use, integrate a secure
                backend/authority dashboard.
              </p>
            </div>
          )}
        </Section>
      </div>
    );
  };

  // Notes cover
  const NotesCover = () => (
    <div className="max-w-3xl mx-auto px-3 py-4">
      <Section title="My Notes">
        {coverReason && <div className="mb-2 text-xs text-gray-600">{coverReason}</div>}
        <textarea
          className="w-full rounded-xl border px-3 py-2 min-h-[260px]"
          placeholder="Write notes..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="mt-3 text-xs text-gray-500">Notes are stored on your device only.</div>
      </Section>
    </div>
  );

  // Lock screen
  const LockScreen = () => (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow p-6 w-full max-w-sm">
        <div className="text-lg font-semibold mb-2">Enter PIN</div>
        <input
          className="w-full rounded-xl border px-3 py-2 mb-3"
          value={pinInput}
          onChange={(e) => setPinInput(e.target.value)}
          inputMode="numeric"
          placeholder="Your PIN"
        />
        <div className="text-xs text-gray-500 mb-3">
          This protects My Reports and Settings on this device.
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={tryUnlock} className="px-4 py-2 rounded-xl bg-gray-900 text-white">
            Unlock
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      {banner && (
        <div className="max-w-7xl mx-auto px-3 mt-2">
          <div
            className={`rounded-xl px-3 py-2 text-sm ${
              banner.type === "error"
                ? "bg-red-50 text-red-700"
                : banner.type === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-blue-50 text-blue-800"
            }`}
          >
            {banner.text}
          </div>
        </div>
      )}
      {tab === "lock" && <LockScreen />}
      {tab !== "lock" && (
        <>
          {tab === "report" && <NewReport />}
          {tab === "my" && <MyReports />}
          {tab === "map" && <MapView />}
          {tab === "help" && <Help />}
          {tab === "settings" && <Settings />}
          {tab === "cover" && <NotesCover />}
        </>
      )}
      <footer className="max-w-7xl mx-auto px-3 py-6 text-xs text-gray-500">
        Demo only • All data stored locally • AAMUSTED project
      </footer>
    </div>
  );
}

// ---------- Image sanitize (EXIF strip via canvas re-encode) ----------
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
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.9);
}
