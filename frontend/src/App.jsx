import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createWorker, OEM, PSM } from "tesseract.js";
import heroImage from "./assets/hero.png";
import "./App.css";

const PUBLIC_ROLE_OPTIONS = [
  {
    id: "buyer",
    label: "Buyer",
    title: "Buyer verification",
    detail: "Check a car before purchase",
  },
  {
    id: "service",
    label: "Service Company",
    title: "Service ledger",
    detail: "Seal maintenance and accident records",
  },
  {
    id: "seller",
    label: "Seller",
    title: "Seller records",
    detail: "Add resale and ownership records",
  },
];

const ROLE_CONFIG = {
  buyer: PUBLIC_ROLE_OPTIONS[0],
  service: PUBLIC_ROLE_OPTIONS[1],
  seller: PUBLIC_ROLE_OPTIONS[2],
  attacker: {
    id: "attacker",
    label: "Security Console",
    title: "Hidden tamper test",
    detail: "Simulate an unauthorized write",
  },
};

const ROLE_LABELS = {
  buyer: "Buyer",
  service: "Service Company",
  seller: "Seller",
  attacker: "Security Console",
  observer: "Observer",
};

const RECORD_TYPES = [
  "Registration",
  "Service",
  "Repair",
  "Accident",
  "Insurance Claim",
  "Seller Declaration",
  "Ownership Transfer",
];

const EMPTY_STATE = {
  chain: [],
  vehicles: [],
  securityEvents: [],
  notifications: [],
  network: {
    roles: {},
    lanUrls: [],
    frontendPort: 5173,
    apiPort: 3001,
  },
  valid: false,
};

const PHOTO_CACHE_KEY = "autotrust-vehicle-photos";
const API_PORT_KEY = "autotrust-api-port";
const MAX_RECORD_PHOTOS = 8;
const MAX_IMAGE_SIZE = 1400;
let odometerOcrWorkerPromise = null;

function getApiBase() {
  const host = window.location.hostname || "localhost";
  const params = new URLSearchParams(window.location.search);
  const apiPortFromUrl = params.get("apiPort");
  const storedApiPort = window.localStorage.getItem(API_PORT_KEY);
  const apiPort = /^\d+$/.test(apiPortFromUrl || "")
    ? apiPortFromUrl
    : /^\d+$/.test(storedApiPort || "")
      ? storedApiPort
      : "3001";

  window.localStorage.setItem(API_PORT_KEY, apiPort);
  return `http://${host}:${apiPort}`;
}

function getInitialRole() {
  const roleFromUrl = new URLSearchParams(window.location.search).get("role");
  const storedRole = window.localStorage.getItem("autotrust-role");

  if (roleFromUrl && ROLE_CONFIG[roleFromUrl]) {
    return roleFromUrl;
  }

  if (PUBLIC_ROLE_OPTIONS.some((option) => option.id === storedRole)) {
    return storedRole;
  }

  return "buyer";
}

function normalizeVin(vin) {
  return String(vin || "").trim().toUpperCase();
}

function shortHash(hash) {
  if (!hash) {
    return "pending";
  }

  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatKm(value) {
  return `${Number(value || 0).toLocaleString("en-IN")} km`;
}

function normalizeOdometerValue(value) {
  const reading = Number(value);

  return Number.isFinite(reading) && reading >= 0 ? Math.round(reading) : null;
}

function odometerProofStatus(odometer, proofReading, proofPhotoUrl, ocrStatus = "") {
  const odometerValue = normalizeOdometerValue(odometer);
  const proofValue = normalizeOdometerValue(proofReading);

  if (!proofPhotoUrl) {
    return {
      className: "pending",
      label: "Photo needed",
      matches: false,
    };
  }

  if (ocrStatus === "reading") {
    return {
      className: "reading",
      label: "Reading image...",
      matches: false,
    };
  }

  if (ocrStatus === "failed") {
    return {
      className: "mismatch",
      label: "OCR failed",
      matches: false,
    };
  }

  if (proofValue === null) {
    return {
      className: "pending",
      label: "OCR needed",
      matches: false,
    };
  }

  if (odometerValue !== null && proofValue !== null && odometerValue === proofValue) {
    return {
      className: "verified",
      label: "OCR verified",
      matches: true,
    };
  }

  return {
    className: "mismatch",
    label: "Reading mismatch",
    matches: false,
  };
}

function vehicleTitle(vehicle) {
  if (!vehicle) {
    return "Vehicle";
  }

  return `${vehicle.vehicle.year} ${vehicle.vehicle.make} ${vehicle.vehicle.model}`;
}

function readPhotoCache() {
  try {
    const cache = JSON.parse(window.localStorage.getItem(PHOTO_CACHE_KEY) || "{}");
    return cache && typeof cache === "object" ? cache : {};
  } catch {
    return {};
  }
}

function uniquePhotos(photoUrls) {
  return photoUrls.filter((photoUrl, index, list) => photoUrl && list.indexOf(photoUrl) === index);
}

function normalizePhotoList(...photoSources) {
  return uniquePhotos(
    photoSources
      .flat()
      .filter(Boolean)
      .map((photoUrl) => String(photoUrl).trim())
      .filter(Boolean),
  ).slice(0, MAX_RECORD_PHOTOS);
}

function getCachedVehiclePhotos(vin) {
  const value = readPhotoCache()[normalizeVin(vin)];

  return normalizePhotoList(Array.isArray(value) ? value : [value]);
}

function cacheVehiclePhotos(vin, photoUrls) {
  const targetVin = normalizeVin(vin);
  const nextPhotos = normalizePhotoList(photoUrls);

  if (!targetVin || !nextPhotos.length) {
    return;
  }

  const cache = readPhotoCache();
  cache[targetVin] = normalizePhotoList(nextPhotos, getCachedVehiclePhotos(targetVin));
  window.localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify(cache));
}

function vehiclePhotos(vehicle) {
  return normalizePhotoList(
    vehicle?.photoUrls,
    vehicle?.photoUrl,
    vehicle?.vehicle?.photoUrls,
    vehicle?.vehicle?.photoUrl,
    getCachedVehiclePhotos(vehicle?.vin),
  );
}

function vehiclePhoto(vehicle) {
  return vehiclePhotos(vehicle)[0] || "";
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read image file."));
    };
    image.src = url;
  });
}

function loadImageFromSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to read image."));
    image.src = source;
  });
}

async function fileToCompressedDataUrl(file) {
  const image = await loadImageFromFile(file);
  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/jpeg", 0.82);
}

async function preprocessImageForOcr(photoUrl) {
  const image = await loadImageFromSource(photoUrl);
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  let scale = 1;

  if (maxSide < 1200) {
    scale = 1200 / maxSide;
  } else if (maxSide > 1800) {
    scale = 1800 / maxSide;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  for (let index = 0; index < pixels.length; index += 4) {
    const gray = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.8 + 128));
    pixels[index] = contrast;
    pixels[index + 1] = contrast;
    pixels[index + 2] = contrast;
  }

  context.putImageData(imageData, 0, 0);

  return canvas.toDataURL("image/png");
}

function extractOdometerReading(ocrText, expectedOdometer) {
  const expectedValue = normalizeOdometerValue(expectedOdometer);
  const expectedLength = String(expectedValue ?? "").length || 1;
  const expectedDigits = expectedValue === null ? "" : String(expectedValue);
  const digitRuns = String(ocrText || "").match(/\d+/g) || [];
  const candidates = [];

  digitRuns.forEach((run, runIndex) => {
    candidates.push({ value: run, runIndex });

    let combined = run;
    for (let nextIndex = runIndex + 1; nextIndex < digitRuns.length; nextIndex += 1) {
      combined += digitRuns[nextIndex];

      if (combined.length > expectedLength + 1) {
        break;
      }

      candidates.push({ value: combined, runIndex });
    }
  });

  if (!candidates.length) {
    return "";
  }

  const normalizedCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      normalized: candidate.value.replace(/^0+(?=\d)/, ""),
    }))
    .filter((candidate) => candidate.normalized);

  const exactMatch = normalizedCandidates.find(
    (candidate) => Number(candidate.normalized) === expectedValue,
  );

  if (exactMatch) {
    return expectedDigits || exactMatch.normalized;
  }

  if (expectedDigits) {
    const closeMatch = normalizedCandidates
      .map((candidate) => ({
        ...candidate,
        distance: digitDistance(candidate.normalized, expectedDigits),
      }))
      .filter((candidate) => candidate.distance <= Math.max(1, Math.floor(expectedLength * 0.18)))
      .sort((first, second) => {
        if (first.distance !== second.distance) {
          return first.distance - second.distance;
        }

        return Math.abs(first.normalized.length - expectedLength) - Math.abs(second.normalized.length - expectedLength);
      })[0];

    if (closeMatch) {
      return expectedDigits;
    }
  }

  return normalizedCandidates.sort((first, second) => {
    const firstDistance = Math.abs(first.normalized.length - expectedLength);
    const secondDistance = Math.abs(second.normalized.length - expectedLength);

    if (firstDistance !== secondDistance) {
      return firstDistance - secondDistance;
    }

    return second.normalized.length - first.normalized.length;
  })[0].normalized;
}

function digitDistance(first, second) {
  const rows = first.length + 1;
  const columns = second.length + 1;
  const distances = Array.from({ length: rows }, () => Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) {
    distances[row][0] = row;
  }

  for (let column = 0; column < columns; column += 1) {
    distances[0][column] = column;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = first[row - 1] === second[column - 1] ? 0 : 1;
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + substitutionCost,
      );
    }
  }

  return distances[first.length][second.length];
}

async function getOdometerOcrWorker() {
  if (!odometerOcrWorkerPromise) {
    odometerOcrWorkerPromise = createWorker(
      "eng",
      OEM.LSTM_ONLY,
      {
        corePath: "/tesseract/core",
        langPath: "/tesseract/lang",
        workerPath: "/tesseract/worker.min.js",
        gzip: true,
      },
      {
        load_freq_dawg: "0",
        load_number_dawg: "0",
        load_system_dawg: "0",
      },
    ).then(async (worker) => {
      await worker.setParameters({
        classify_bln_numeric_mode: "1",
        tessedit_char_whitelist: "0123456789",
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      });

      return worker;
    });
  }

  return odometerOcrWorkerPromise;
}

async function recognizeOdometerFromImage(photoUrl, expectedOdometer) {
  const worker = await getOdometerOcrWorker();
  const preparedImage = await preprocessImageForOcr(photoUrl);
  const {
    data: { confidence, text },
  } = await worker.recognize(preparedImage);
  const reading = extractOdometerReading(text, expectedOdometer);

  return {
    confidence: Math.round(Number(confidence || 0)),
    rawText: String(text || "").trim(),
    reading,
  };
}

function trustStatus(vehicle, isValid) {
  if (!vehicle) {
    return "No record";
  }

  if (!isValid) {
    return "Review needed";
  }

  if (vehicle.accidentCount > 0) {
    return "Verified with notes";
  }

  return "Verified clear";
}

function mergeNotifications(...lists) {
  const byId = new Map();

  lists.flat().forEach((note) => {
    if (note?.id && !byId.has(note.id)) {
      byId.set(note.id, note);
    }
  });

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function safeJson(response) {
  return response.json().catch(() => ({}));
}

function App() {
  const apiBase = useMemo(() => getApiBase(), []);
  const [role, setRole] = useState(getInitialRole);
  const roleRef = useRef(role);
  const socketRef = useRef(null);
  const [state, setState] = useState(EMPTY_STATE);
  const [notifications, setNotifications] = useState([]);
  const [networkStatus, setNetworkStatus] = useState("connecting");
  const [selectedVin, setSelectedVin] = useState("VIN1001");
  const [vehicleSearch, setVehicleSearch] = useState("VIN1001");
  const [buyerMessage, setBuyerMessage] = useState("");
  const [serviceMessage, setServiceMessage] = useState("");
  const [tamperMessage, setTamperMessage] = useState("");
  const [lastTamper, setLastTamper] = useState(null);
  const [busyAction, setBusyAction] = useState("");
  const [recordForm, setRecordForm] = useState({
    vin: "VIN1001",
    type: "Service",
    odometer: "17600",
    description: "General inspection completed with verified odometer reading.",
    owner: "Rahul Mehta",
    company: "AutoTrust Service Hub",
    make: "Tata",
    model: "Nexon EV",
    year: "2023",
    color: "Blue",
    plate: "KA-01-AT-1001",
    odometerPhotoUrl: "",
    odometerPhotoReading: "",
    odometerOcrConfidence: null,
    odometerOcrStatus: "idle",
    odometerOcrText: "",
    photoUrl: "",
    photoUrls: [],
  });
  const [tamperForm, setTamperForm] = useState({
    vin: "VIN1001",
    targetIndex: "3",
    fakeOdometer: "5000",
    fakeDescription: "Replace accident record with clean history and lower odometer.",
    requestedBy: "external-write-source",
  });

  function applyState(nextState) {
    const normalized = {
      ...EMPTY_STATE,
      ...nextState,
      network: {
        ...EMPTY_STATE.network,
        ...(nextState.network || {}),
      },
    };

    setState(normalized);
    normalized.vehicles.forEach((vehicle) => {
      const photos = normalizePhotoList(
        vehicle?.photoUrls,
        vehicle?.photoUrl,
        vehicle?.vehicle?.photoUrls,
        vehicle?.vehicle?.photoUrl,
      );

      if (photos.length) {
        cacheVehiclePhotos(vehicle.vin, photos);
      }
    });
    setNotifications((current) =>
      mergeNotifications(normalized.notifications || [], current).slice(0, 60),
    );
  }

  function addNotification(note) {
    setNotifications((current) => mergeNotifications([note], current).slice(0, 60));
  }

  useEffect(() => {
    const socket = io(apiBase, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setNetworkStatus("online");
      socket.emit("joinRole", roleRef.current);
    });

    socket.on("disconnect", () => setNetworkStatus("offline"));
    socket.on("connect_error", () => setNetworkStatus("offline"));
    socket.on("state", applyState);
    socket.on("notification", addNotification);
    socket.on("tamperAlert", addNotification);

    fetch(`${apiBase}/api/state`)
      .then(safeJson)
      .then(applyState)
      .catch(() => setNetworkStatus("offline"));

    return () => {
      socket.disconnect();
    };
  }, [apiBase]);

  useEffect(() => {
    roleRef.current = role;

    if (PUBLIC_ROLE_OPTIONS.some((option) => option.id === role)) {
      window.localStorage.setItem("autotrust-role", role);
    } else {
      window.localStorage.removeItem("autotrust-role");
    }

    socketRef.current?.emit("joinRole", role);
  }, [role]);

  const vehicles = state.vehicles;
  const chain = state.chain;
  const selectedVehicle = useMemo(() => {
    return vehicles.find((vehicle) => vehicle.vin === selectedVin) || vehicles[0] || null;
  }, [selectedVin, vehicles]);
  const tamperVehicle = useMemo(() => {
    return vehicles.find((vehicle) => vehicle.vin === normalizeVin(tamperForm.vin)) || null;
  }, [tamperForm.vin, vehicles]);
  const primaryLanUrl = state.network?.lanUrls?.[0]?.frontend;
  const apiPort = state.network?.apiPort || 3001;
  const liveUrl =
    apiPort === 3001
      ? primaryLanUrl || window.location.origin
      : `${primaryLanUrl || window.location.origin}?apiPort=${apiPort}`;
  const roleCounts = state.network?.roles || {};

  function handleSelectVehicle(vin) {
    const targetVin = normalizeVin(vin);
    const vehicle = vehicles.find((item) => item.vin === targetVin);

    setSelectedVin(targetVin);
    setVehicleSearch(targetVin);

    if (vehicle) {
      setRecordForm((current) => ({
        ...current,
        vin: vehicle.vin,
        odometer: String(vehicle.currentOdometer + 100),
        owner: vehicle.owner,
        company: vehicle.company,
        make: vehicle.vehicle.make,
        model: vehicle.vehicle.model,
        year: vehicle.vehicle.year,
        color: vehicle.vehicle.color,
        plate: vehicle.vehicle.plate,
        odometerPhotoUrl: "",
        odometerPhotoReading: "",
        odometerOcrConfidence: null,
        odometerOcrStatus: "idle",
        odometerOcrText: "",
        photoUrl: "",
        photoUrls: [],
      }));
      setTamperForm((current) => ({
        ...current,
        vin: vehicle.vin,
        targetIndex: String(vehicle.lastBlockIndex || ""),
      }));
    }
  }

  function verifyVehicle() {
    const targetVin = normalizeVin(vehicleSearch);
    const vehicle = vehicles.find((item) => item.vin === targetVin);

    setSelectedVin(targetVin);

    if (!vehicle) {
      setBuyerMessage("No verified blockchain record exists for this VIN.");
      return;
    }

    setBuyerMessage(
      `${vehicle.vin} verified. ${vehicle.records.length} immutable records found and chain status is ${state.valid ? "valid" : "invalid"}.`,
    );
  }

  async function addRecord() {
    setServiceMessage("");
    setBusyAction("record");
    const submittedVin = normalizeVin(recordForm.vin);
    const recordPhotoUrls = normalizePhotoList(recordForm.photoUrls);

    try {
      const response = await fetch(`${apiBase}/api/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...recordForm,
          vin: submittedVin,
          odometer: Number(recordForm.odometer),
          odometerPhotoReading:
            recordForm.odometerPhotoReading === "" ? undefined : Number(recordForm.odometerPhotoReading),
          odometerOcrConfidence: recordForm.odometerOcrConfidence,
          odometerOcrText: recordForm.odometerOcrText,
          photoUrl: recordPhotoUrls[0] || "",
          photoUrls: recordPhotoUrls,
          requestedBy: recordForm.company,
        }),
      });
      const result = await safeJson(response);

      if (!response.ok) {
        throw new Error(result.error || "Unable to add record.");
      }

      setServiceMessage(`Block #${result.block.index} sealed for ${result.block.data.vin}.`);
      cacheVehiclePhotos(
        result.block.data.vin,
        normalizePhotoList(recordPhotoUrls, result.vehicle?.photoUrls, result.vehicle?.photoUrl),
      );
      setSelectedVin(result.block.data.vin);
      setVehicleSearch(result.block.data.vin);
      setRecordForm((current) => ({
        ...current,
        ...(() => {
          const nextOdometer = String(Number(current.odometer || 0) + 500);

          return {
            odometer: nextOdometer,
            odometerPhotoReading: "",
            odometerOcrConfidence: null,
            odometerOcrStatus: "idle",
            odometerOcrText: "",
          };
        })(),
        description: "",
        odometerPhotoUrl: "",
        photoUrl: "",
        photoUrls: [],
      }));
    } catch (error) {
      setServiceMessage(error.message);
    } finally {
      setBusyAction("");
    }
  }

  async function attemptTamper() {
    setTamperMessage("");
    setLastTamper(null);
    setBusyAction("tamper");

    try {
      const response = await fetch(`${apiBase}/api/tamper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...tamperForm,
          vin: normalizeVin(tamperForm.vin),
          targetIndex: Number(tamperForm.targetIndex),
          fakeOdometer: Number(tamperForm.fakeOdometer),
        }),
      });
      const result = await safeJson(response);

      if (!response.ok && !result.reason) {
        throw new Error(result.error || "Tamper request failed.");
      }

      setTamperMessage(result.reason || "Tamper attempt blocked.");
      setLastTamper({
        targetBlock: result.targetBlock,
        alertBlock: result.alertBlock,
      });
    } catch (error) {
      setTamperMessage(error.message);
    } finally {
      setBusyAction("");
    }
  }

  const statusClass = networkStatus === "online" ? "online" : "offline";
  const activeRole = ROLE_CONFIG[role] || ROLE_CONFIG.buyer;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-art" src={heroImage} alt="Blockchain layers" />
          <div>
            <p className="eyebrow">AutoTrust Ledger</p>
            <h1>Vehicle Identity Blockchain</h1>
            <p className="brand-copy">
              Chassis history, odometer readings, service events, accident claims, and attack
              alerts in one append-only ledger.
            </p>
          </div>
        </div>
        <div className="status-stack">
          <span className={`status-pill ${statusClass}`}>
            {networkStatus === "online" ? "Node online" : "Node offline"}
          </span>
          <span className={`status-pill ${state.valid ? "valid" : "invalid"}`}>
            {state.valid ? "Valid chain" : "Invalid chain"}
          </span>
        </div>
      </header>

      <section className="command-band">
        <div className="role-tabs" aria-label="Select role">
          {PUBLIC_ROLE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`role-tab ${role === option.id ? "active" : ""}`}
              type="button"
              onClick={() => setRole(option.id)}
            >
              <span>{option.label}</span>
              <small>{option.detail}</small>
            </button>
          ))}
        </div>
        <div className="network-endpoint">
          <span>LAN URL</span>
          <strong>{liveUrl}</strong>
          <small>API: {apiBase}</small>
        </div>
      </section>

      <main className="workspace">
        <section className="primary-work">
          <div className="panel-header">
            <div>
              <p className="section-kicker">{activeRole.title}</p>
              <h2>{activeRole.detail}</h2>
            </div>
            <span className={`role-badge ${role}`}>{ROLE_LABELS[role]}</span>
          </div>

          {role === "buyer" && (
            <BuyerPanel
              buyerMessage={buyerMessage}
              isValid={state.valid}
              onSelectVehicle={handleSelectVehicle}
              onVerify={verifyVehicle}
              selectedVehicle={selectedVehicle}
              vehicleSearch={vehicleSearch}
              vehicles={vehicles}
              setVehicleSearch={setVehicleSearch}
            />
          )}

          {(role === "service" || role === "seller") && (
            <ServicePanel
              actionLabel={role === "seller" ? "Add Seller Record" : "Add Immutable Record"}
              issuerLabel={role === "seller" ? "Seller name" : "Service company"}
              busyAction={busyAction}
              message={serviceMessage}
              onAddRecord={addRecord}
              recordForm={recordForm}
              selectedVehicle={selectedVehicle}
              setRecordForm={setRecordForm}
              vehicles={vehicles}
            />
          )}

          {role === "attacker" && (
            <AttackerPanel
              busyAction={busyAction}
              lastTamper={lastTamper}
              message={tamperMessage}
              onAttemptTamper={attemptTamper}
              setTamperForm={setTamperForm}
              tamperForm={tamperForm}
              tamperVehicle={tamperVehicle}
              vehicles={vehicles}
            />
          )}
        </section>

        <aside className="side-rail">
          <NetworkPanel roleCounts={roleCounts} chain={chain} valid={state.valid} />
          <NotificationPanel notifications={notifications} />
        </aside>
      </main>

      <section className="audit-grid">
        <VehicleDirectory
          onSelectVehicle={handleSelectVehicle}
          selectedVin={selectedVehicle?.vin}
          vehicles={vehicles}
        />
        <BlockchainExplorer chain={chain} securityEvents={state.securityEvents || []} />
      </section>
    </div>
  );
}

function BuyerPanel({
  buyerMessage,
  isValid,
  onSelectVehicle,
  onVerify,
  selectedVehicle,
  setVehicleSearch,
  vehicleSearch,
  vehicles,
}) {
  const selectedPhoto = vehiclePhoto(selectedVehicle);
  const selectedPhotos = vehiclePhotos(selectedVehicle);
  const selectedOdometerProof = selectedVehicle?.odometerProof || null;
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [imageViewerIndex, setImageViewerIndex] = useState(0);

  return (
    <div className="role-content buyer-dashboard">
      <div className="buyer-overview">
        <section className="finder-panel">
          <div className="mini-heading">
            <span>Quick check</span>
            <strong>Search by VIN</strong>
          </div>
          <div className="search-row">
            <input
              list="vehicle-vins"
              value={vehicleSearch}
              onChange={(event) => setVehicleSearch(event.target.value)}
              placeholder="Enter VIN or chassis number"
            />
            <datalist id="vehicle-vins">
              {vehicles.map((vehicle) => (
                <option key={vehicle.vin} value={vehicle.vin} />
              ))}
            </datalist>
            <button className="primary-button" type="button" onClick={onVerify}>
              Verify History
            </button>
          </div>

          {buyerMessage && (
            <div className={`callout ${buyerMessage.startsWith("No") ? "alert" : "success"}`}>
              {buyerMessage}
            </div>
          )}

          <div className="quick-vehicle-list" aria-label="Quick vehicle selection">
            {vehicles.map((vehicle) => (
              <button
                key={vehicle.vin}
                className={`quick-vehicle-card ${vehicle.vin === selectedVehicle?.vin ? "active" : ""}`}
                type="button"
                onClick={() => onSelectVehicle(vehicle.vin)}
              >
                <VehicleImage className="quick-thumb" vehicle={vehicle} />
                <span>
                  <strong>{vehicle.vin}</strong>
                  <small>{vehicleTitle(vehicle)}</small>
                  <small>{vehicle.owner}</small>
                </span>
              </button>
            ))}
          </div>
        </section>

        {selectedVehicle ? (
          <section className="vehicle-hero-card">
            <div className="vehicle-photo-frame">
              <button
                aria-label={`Open full image for ${vehicleTitle(selectedVehicle)}`}
                className="vehicle-photo-button"
                type="button"
                onClick={() => {
                  setImageViewerIndex(0);
                  setImageViewerOpen(true);
                }}
              >
                <VehicleImage vehicle={selectedVehicle} />
              </button>
              <span className={`photo-proof ${selectedPhoto ? "ready" : "preview"}`}>
                {selectedPhoto ? "Photo linked" : "No image"}
              </span>
            </div>
            <div className="vehicle-hero-copy">
              <p className="section-kicker">Trust summary</p>
              <h3>{vehicleTitle(selectedVehicle)}</h3>
              <span className={`trust-grade ${isValid ? "valid" : "invalid"}`}>
                {trustStatus(selectedVehicle, isValid)}
              </span>
              <div className="trust-checks">
                <span>
                  <strong>
                    {selectedPhoto ? `${selectedPhotos.length} image${selectedPhotos.length === 1 ? "" : "s"}` : "No image uploaded"}
                  </strong>
                  <small>Vehicle photo</small>
                </span>
                <span>
                  <strong>{selectedVehicle.records.length} records</strong>
                  <small>Immutable blocks</small>
                </span>
                <span>
                  <strong>{formatKm(selectedVehicle.currentOdometer)}</strong>
                  <small>Latest odometer</small>
                </span>
                <span>
                  <strong>{isValid ? "Hash locked" : "Hash issue"}</strong>
                  <small>Blockchain proof</small>
                </span>
              </div>
            </div>
          </section>
        ) : (
          <div className="empty-panel">No vehicle selected.</div>
        )}
      </div>

      {selectedVehicle ? (
        <>
          {selectedPhotos.length > 1 && (
            <div className="buyer-photo-gallery" aria-label="Vehicle photos">
              {selectedPhotos.map((photoUrl, index) => (
                <button
                  key={photoUrl}
                  type="button"
                  onClick={() => {
                    setImageViewerIndex(index);
                    setImageViewerOpen(true);
                  }}
                >
                  <VehicleImage className="gallery-thumb" src={photoUrl} vehicle={selectedVehicle} />
                </button>
              ))}
            </div>
          )}

          <div className="summary-grid">
            <Metric label="VIN" value={selectedVehicle.vin} />
            <Metric
              label="Vehicle"
              value={`${selectedVehicle.vehicle.year} ${selectedVehicle.vehicle.make} ${selectedVehicle.vehicle.model}`}
            />
            <Metric label="Current odometer" value={formatKm(selectedVehicle.currentOdometer)} />
            <Metric label="Accident records" value={selectedVehicle.accidentCount} />
          </div>

          <OdometerProofSummary proof={selectedOdometerProof} vehicle={selectedVehicle} />

          <div className="identity-strip">
            <div>
              <span>Owner</span>
              <strong>{selectedVehicle.owner}</strong>
            </div>
            <div>
              <span>Plate</span>
              <strong>{selectedVehicle.vehicle.plate}</strong>
            </div>
            <div>
              <span>Last hash</span>
              <strong>{shortHash(selectedVehicle.lastHash)}</strong>
            </div>
            <div>
              <span>Chain proof</span>
              <strong>{isValid ? "Verified" : "Broken"}</strong>
            </div>
          </div>

          <HistoryTimeline records={selectedVehicle.records} />

          <div className="vehicle-switcher">
            {vehicles.map((vehicle) => (
              <button
                key={vehicle.vin}
                type="button"
                className={vehicle.vin === selectedVehicle.vin ? "selected" : ""}
                onClick={() => onSelectVehicle(vehicle.vin)}
              >
                {vehicle.vin}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {imageViewerOpen && selectedVehicle && (
        <ImageLightbox
          initialIndex={imageViewerIndex}
          vehicle={selectedVehicle}
          onClose={() => setImageViewerOpen(false)}
        />
      )}
    </div>
  );
}

function OdometerProofSummary({ proof, vehicle }) {
  const [open, setOpen] = useState(false);
  const proofStatus = odometerProofStatus(vehicle?.currentOdometer, proof?.reading, proof?.photoUrl);

  return (
    <section className="odometer-proof-summary">
      <div className="odometer-proof-preview compact">
        {proof?.photoUrl ? (
          <button
            aria-label="Open odometer proof photo"
            type="button"
            onClick={() => setOpen(true)}
          >
            <EvidenceImage label="Odometer proof photo" src={proof.photoUrl} />
          </button>
        ) : (
          <EvidenceImage label="Odometer proof photo" placeholder="No odometer photo" />
        )}
      </div>
      <div className="odometer-proof-copy">
        <div className="mini-heading">
          <span>Odometer proof</span>
          <strong>{proof?.reading !== undefined ? formatKm(proof.reading) : "Not submitted"}</strong>
        </div>
        <span className={`proof-status ${proofStatus.className}`}>{proofStatus.label}</span>
        <p>
          {proof?.photoUrl
            ? `OCR read ${formatKm(proof.reading)} from the photo and matched the ledger odometer ${formatKm(vehicle.currentOdometer)}${
                Number.isFinite(Number(proof.ocrConfidence))
                  ? ` (${proof.ocrConfidence}% confidence).`
                  : "."
              }`
            : "Service or seller can upload an odometer photo when adding the next record."}
        </p>
      </div>
      {open && proof?.photoUrl && (
        <ProofLightbox
          label={`${vehicleTitle(vehicle)} odometer proof`}
          src={proof.photoUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

function ServicePanel({
  actionLabel,
  busyAction,
  issuerLabel,
  message,
  onAddRecord,
  recordForm,
  selectedVehicle,
  setRecordForm,
  vehicles,
}) {
  const uploadedPhotos = normalizePhotoList(recordForm.photoUrls);
  const previewPhotos = uploadedPhotos.length ? uploadedPhotos : vehiclePhotos(selectedVehicle);
  const odometerProof = odometerProofStatus(
    recordForm.odometer,
    recordForm.odometerPhotoReading,
    recordForm.odometerPhotoUrl,
    recordForm.odometerOcrStatus,
  );
  const previewVehicle = {
    vin: normalizeVin(recordForm.vin) || "NEW",
    photoUrl: previewPhotos[0] || "",
    photoUrls: previewPhotos,
    vehicle: {
      ...(selectedVehicle?.vehicle || {}),
      make: recordForm.make || selectedVehicle?.vehicle?.make || "Unknown",
      model: recordForm.model || selectedVehicle?.vehicle?.model || "Unknown",
      year: recordForm.year || selectedVehicle?.vehicle?.year || "Unknown",
      color: recordForm.color || selectedVehicle?.vehicle?.color || "Unknown",
      plate: recordForm.plate || selectedVehicle?.vehicle?.plate || "Unassigned",
      photoUrls: previewPhotos,
    },
  };

  async function handlePhotoUpload(event) {
    const files = Array.from(event.target.files || [])
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, MAX_RECORD_PHOTOS - uploadedPhotos.length);

    if (!files.length) {
      return;
    }

    const results = await Promise.allSettled(files.map((file) => fileToCompressedDataUrl(file)));
    const nextPhotos = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    if (!nextPhotos.length) {
      return;
    }

    setRecordForm((current) => {
      const photoUrls = normalizePhotoList(current.photoUrls, nextPhotos);

      return {
        ...current,
        photoUrl: photoUrls[0] || "",
        photoUrls,
      };
    });

    event.target.value = "";
  }

  async function handleOdometerPhotoUpload(event) {
    const file = Array.from(event.target.files || []).find((item) => item.type.startsWith("image/"));

    if (!file) {
      return;
    }

    const photoUrl = await fileToCompressedDataUrl(file);
    const expectedOdometer = recordForm.odometer;

    setRecordForm((current) => ({
      ...current,
      odometerPhotoUrl: photoUrl,
      odometerPhotoReading: "",
      odometerOcrConfidence: null,
      odometerOcrStatus: "reading",
      odometerOcrText: "",
    }));

    event.target.value = "";

    try {
      const result = await recognizeOdometerFromImage(photoUrl, expectedOdometer);

      setRecordForm((current) => ({
        ...current,
        odometerPhotoReading: result.reading,
        odometerOcrConfidence: result.confidence,
        odometerOcrStatus: result.reading ? "read" : "failed",
        odometerOcrText: result.rawText,
      }));
    } catch (error) {
      setRecordForm((current) => ({
        ...current,
        odometerPhotoReading: "",
        odometerOcrConfidence: null,
        odometerOcrStatus: "failed",
        odometerOcrText: error.message,
      }));
    }
  }

  function removePhoto(indexToRemove) {
    setRecordForm((current) => {
      const photoUrls = normalizePhotoList(current.photoUrls).filter(
        (photoUrl, index) => photoUrl && index !== indexToRemove,
      );

      return {
        ...current,
        photoUrl: photoUrls[0] || "",
        photoUrls,
      };
    });
  }

  return (
    <div className="role-content">
      <div className="form-grid">
        <label>
          VIN / chassis number
          <input
            list="service-vins"
            value={recordForm.vin}
            onChange={(event) => setRecordForm((current) => ({ ...current, vin: event.target.value }))}
          />
          <datalist id="service-vins">
            {vehicles.map((vehicle) => (
              <option key={vehicle.vin} value={vehicle.vin} />
            ))}
          </datalist>
        </label>
        <label>
          Record type
          <select
            value={recordForm.type}
            onChange={(event) => setRecordForm((current) => ({ ...current, type: event.target.value }))}
          >
            {RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Odometer
          <input
            min="0"
            type="number"
            value={recordForm.odometer}
            onChange={(event) =>
              setRecordForm((current) => ({
                ...current,
                odometer: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Owner
          <input
            value={recordForm.owner}
            onChange={(event) => setRecordForm((current) => ({ ...current, owner: event.target.value }))}
          />
        </label>
        <label>
          {issuerLabel}
          <input
            value={recordForm.company}
            onChange={(event) =>
              setRecordForm((current) => ({ ...current, company: event.target.value }))
            }
          />
        </label>
        <label>
          Plate number
          <input
            value={recordForm.plate}
            onChange={(event) => setRecordForm((current) => ({ ...current, plate: event.target.value }))}
          />
        </label>
      </div>

      <div className="odometer-proof-panel">
        <div className="odometer-proof-preview">
          <EvidenceImage
            label="Odometer proof photo"
            src={recordForm.odometerPhotoUrl}
            placeholder="Odometer photo"
          />
        </div>
        <div className="odometer-proof-copy">
          <div className="mini-heading">
            <span>Odometer proof</span>
            <strong>{odometerProof.label}</strong>
          </div>
          <div className="odometer-proof-fields">
            <label>
              OCR reading from photo
              <input
                min="0"
                placeholder="Upload photo to read"
                readOnly
                type="number"
                value={recordForm.odometerPhotoReading}
              />
            </label>
            <span className={`proof-status ${odometerProof.className}`}>
              {odometerProof.label}
            </span>
          </div>
          <div className="photo-action-row">
            <label className="file-button">
              Upload Odometer Photo
              <input accept="image/*" type="file" onChange={handleOdometerPhotoUpload} />
            </label>
            {recordForm.odometerPhotoUrl && (
              <button
                className="ghost-button"
                type="button"
                onClick={() =>
                  setRecordForm((current) => ({
                    ...current,
                    odometerPhotoUrl: "",
                    odometerPhotoReading: "",
                    odometerOcrConfidence: null,
                    odometerOcrStatus: "idle",
                    odometerOcrText: "",
                  }))
                }
              >
                Remove
              </button>
            )}
          </div>
          <span className="inline-proof">
            {recordForm.odometerPhotoUrl
              ? `Ledger odometer: ${formatKm(recordForm.odometer)}${
                  recordForm.odometerOcrConfidence !== null
                    ? ` - OCR confidence ${recordForm.odometerOcrConfidence}%`
                    : ""
                }`
              : "Upload a dashboard/odometer photo. OCR will read the number automatically."}
          </span>
          {recordForm.odometerOcrText && (
            <span className="ocr-raw-text">Raw OCR text: {recordForm.odometerOcrText}</span>
          )}
        </div>
      </div>

      {recordForm.type === "Registration" && (
        <div className="form-grid compact">
          <label>
            Make
            <input
              value={recordForm.make}
              onChange={(event) => setRecordForm((current) => ({ ...current, make: event.target.value }))}
            />
          </label>
          <label>
            Model
            <input
              value={recordForm.model}
              onChange={(event) => setRecordForm((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
          <label>
            Year
            <input
              value={recordForm.year}
              onChange={(event) => setRecordForm((current) => ({ ...current, year: event.target.value }))}
            />
          </label>
          <label>
            Color
            <input
              value={recordForm.color}
              onChange={(event) => setRecordForm((current) => ({ ...current, color: event.target.value }))}
            />
          </label>
        </div>
      )}

      <div className="photo-evidence-panel">
        <div className="photo-evidence-preview">
          <VehicleImage vehicle={previewVehicle} />
        </div>
        <div className="photo-evidence-copy">
          <div className="mini-heading">
            <span>Vehicle photos</span>
            <strong>
              {uploadedPhotos.length
                ? `${uploadedPhotos.length} photo${uploadedPhotos.length === 1 ? "" : "s"} ready`
                : "Add car images"}
            </strong>
          </div>
          <div className="photo-action-row">
            <label className="file-button">
              Upload Photos
              <input
                accept="image/*"
                multiple
                type="file"
                onChange={handlePhotoUpload}
              />
            </label>
            {uploadedPhotos.length > 0 && (
              <button
                className="ghost-button"
                type="button"
                onClick={() =>
                  setRecordForm((current) => ({ ...current, photoUrl: "", photoUrls: [] }))
                }
              >
                Remove All
              </button>
            )}
          </div>
          {uploadedPhotos.length > 0 && (
            <div className="uploaded-photo-grid" aria-label="Photos ready to seal">
              {uploadedPhotos.map((photoUrl, index) => (
                <button key={photoUrl} type="button" onClick={() => removePhoto(index)}>
                  <VehicleImage className="upload-thumb" src={photoUrl} vehicle={previewVehicle} />
                  <span>Remove</span>
                </button>
              ))}
            </div>
          )}
          <span className="inline-proof">
            {uploadedPhotos.length
              ? "These photos will be sealed with the next block."
              : "You can add up to 8 photos per record."}
          </span>
        </div>
      </div>

      <label className="wide-label">
        Description
        <textarea
          rows="4"
          value={recordForm.description}
          onChange={(event) =>
            setRecordForm((current) => ({ ...current, description: event.target.value }))
          }
        />
      </label>

      <div className="action-row">
        <button
          className="primary-button"
          disabled={busyAction === "record" || !odometerProof.matches}
          type="button"
          onClick={onAddRecord}
        >
          {busyAction === "record" ? "Sealing..." : odometerProof.matches ? actionLabel : "Verify Odometer Photo"}
        </button>
        {selectedVehicle && (
          <span className="inline-proof">
            Last verified odometer: {formatKm(selectedVehicle.currentOdometer)}
          </span>
        )}
      </div>

      {message && (
        <div className={`callout ${message.includes("rejected") || message.includes("Unable") ? "alert" : "success"}`}>
          {message}
        </div>
      )}
    </div>
  );
}

function AttackerPanel({
  busyAction,
  lastTamper,
  message,
  onAttemptTamper,
  setTamperForm,
  tamperForm,
  tamperVehicle,
  vehicles,
}) {
  const records = tamperVehicle?.records || [];

  return (
    <div className="role-content">
      <div className="danger-banner">
        <strong>Attack simulation</strong>
        <span>
          Existing blocks are never edited by this API. A failed attack becomes a new security
          block and all connected laptops receive the alert.
        </span>
      </div>

      <div className="form-grid">
        <label>
          Target VIN
          <select
            value={normalizeVin(tamperForm.vin)}
            onChange={(event) => {
              const vin = event.target.value;
              const vehicle = vehicles.find((item) => item.vin === vin);
              setTamperForm((current) => ({
                ...current,
                vin,
                targetIndex: String(vehicle?.lastBlockIndex || ""),
              }));
            }}
          >
            {vehicles.map((vehicle) => (
              <option key={vehicle.vin} value={vehicle.vin}>
                {vehicle.vin}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target block
          <select
            value={String(tamperForm.targetIndex)}
            onChange={(event) =>
              setTamperForm((current) => ({ ...current, targetIndex: event.target.value }))
            }
          >
            {records.map((block) => (
              <option key={block.index} value={block.index}>
                Block #{block.index} - {block.data.type} - {shortHash(block.hash)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fake odometer
          <input
            min="0"
            type="number"
            value={tamperForm.fakeOdometer}
            onChange={(event) =>
              setTamperForm((current) => ({ ...current, fakeOdometer: event.target.value }))
            }
          />
        </label>
        <label>
          Test source id
          <input
            value={tamperForm.requestedBy}
            onChange={(event) =>
              setTamperForm((current) => ({ ...current, requestedBy: event.target.value }))
            }
          />
        </label>
      </div>

      <label className="wide-label">
        Fake change request
        <textarea
          rows="4"
          value={tamperForm.fakeDescription}
          onChange={(event) =>
            setTamperForm((current) => ({ ...current, fakeDescription: event.target.value }))
          }
        />
      </label>

      <button
        className="danger-button"
        disabled={busyAction === "tamper" || !records.length}
        type="button"
        onClick={onAttemptTamper}
      >
        {busyAction === "tamper" ? "Testing..." : "Attempt Tamper"}
      </button>

      {message && <div className="callout alert">{message}</div>}

      {lastTamper?.targetBlock && (
        <div className="proof-grid">
          <Metric label="Target stayed unchanged" value={`Block #${lastTamper.targetBlock.index}`} />
          <Metric label="Original hash" value={shortHash(lastTamper.targetBlock.hash)} />
          <Metric label="Alert block" value={`Block #${lastTamper.alertBlock?.index}`} />
          <Metric label="Alert hash" value={shortHash(lastTamper.alertBlock?.hash)} />
        </div>
      )}
    </div>
  );
}

function EvidenceImage({ label, placeholder = "Image proof", src = "" }) {
  if (src) {
    return <img className="evidence-image" src={src} alt={label} />;
  }

  return (
    <div className="evidence-image evidence-placeholder" aria-label={label}>
      <span>{placeholder}</span>
    </div>
  );
}

function ProofLightbox({ label, onClose, src }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="image-lightbox-panel proof-panel" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-topline">
          <strong>{label}</strong>
          <button className="lightbox-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <img className="lightbox-image" src={src} alt={label} />
      </div>
    </div>
  );
}

function ImageLightbox({ initialIndex = 0, onClose, vehicle }) {
  const photos = vehiclePhotos(vehicle);
  const [activeIndex, setActiveIndex] = useState(
    Math.min(Math.max(initialIndex, 0), Math.max(photos.length - 1, 0)),
  );
  const activePhoto = photos[activeIndex] || "";
  const hasMultiplePhotos = photos.length > 1;

  function showPreviousPhoto() {
    setActiveIndex((current) => (current <= 0 ? photos.length - 1 : current - 1));
  }

  function showNextPhoto() {
    setActiveIndex((current) => (current >= photos.length - 1 ? 0 : current + 1));
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && photos.length > 1) {
        setActiveIndex((current) => (current <= 0 ? photos.length - 1 : current - 1));
      } else if (event.key === "ArrowRight" && photos.length > 1) {
        setActiveIndex((current) => (current >= photos.length - 1 ? 0 : current + 1));
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, photos.length]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-topline">
          <strong>
            {vehicleTitle(vehicle)}
            {photos.length > 1 ? ` - ${activeIndex + 1} of ${photos.length}` : ""}
          </strong>
          <button className="lightbox-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="lightbox-stage">
          {hasMultiplePhotos && (
            <button className="lightbox-arrow previous" type="button" onClick={showPreviousPhoto}>
              Prev
            </button>
          )}
          <VehicleImage className="lightbox-image" src={activePhoto} vehicle={vehicle} />
          {hasMultiplePhotos && (
            <button className="lightbox-arrow next" type="button" onClick={showNextPhoto}>
              Next
            </button>
          )}
        </div>
        {hasMultiplePhotos && (
          <div className="lightbox-thumbs" aria-label="Full image gallery">
            {photos.map((photoUrl, index) => (
              <button
                key={photoUrl}
                className={index === activeIndex ? "active" : ""}
                type="button"
                onClick={() => setActiveIndex(index)}
              >
                <VehicleImage className="lightbox-thumb" src={photoUrl} vehicle={vehicle} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VehicleImage({ className = "", src = "", vehicle }) {
  const photo = src || vehiclePhoto(vehicle);
  const [failedSource, setFailedSource] = useState("");
  const imageSource = photo && failedSource !== photo ? photo : "";
  const title = vehicleTitle(vehicle);

  if (!imageSource) {
    return (
      <div className={`vehicle-image vehicle-image-placeholder ${className}`} aria-label={title}>
        <span>No image uploaded</span>
      </div>
    );
  }

  return (
    <img
      className={`vehicle-image ${className}`}
      src={imageSource}
      alt={`${title} evidence`}
      onError={() => {
        setFailedSource(imageSource);
      }}
    />
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HistoryTimeline({ records }) {
  return (
    <div className="timeline">
      <div className="subhead">
        <h3>Verified History</h3>
        <span>{records.length} records</span>
      </div>
      {records.map((block) => (
        <article className="timeline-item" key={block.hash}>
          <div className="timeline-marker">{block.index}</div>
          <div className="timeline-body">
            <div className="timeline-title">
              <strong>{block.data.type}</strong>
              <span>{formatDateTime(block.timestamp)}</span>
            </div>
            <p>{block.data.description}</p>
            <div className="hash-row">
              <span>Odometer: {formatKm(block.data.odometer)}</span>
              <span>Hash: {shortHash(block.hash)}</span>
              <span>Previous: {shortHash(block.previousHash)}</span>
            </div>
            {block.data.odometerPhotoUrl && (
              <div className="odometer-proof-mini">
                <span className={`proof-status ${block.data.odometerVerified ? "verified" : "mismatch"}`}>
                  {block.data.odometerVerified ? "Odometer photo verified" : "Odometer proof mismatch"}
                </span>
                <span>
                  OCR reading: {formatKm(block.data.odometerPhotoReading)}
                  {Number.isFinite(Number(block.data.odometerOcrConfidence))
                    ? ` (${block.data.odometerOcrConfidence}% confidence)`
                    : ""}
                </span>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function NetworkPanel({ chain, roleCounts, valid }) {
  return (
    <section className="side-panel">
      <div className="subhead">
        <h3>Network</h3>
        <span>{valid ? "healthy" : "invalid"}</span>
      </div>
      <div className="network-metrics">
        <Metric label="Blocks" value={chain.length} />
        <Metric label="Vehicle records" value={chain.filter((block) => block.data?.category === "vehicle").length} />
      </div>
      <div className="role-counts">
        {["buyer", "service", "seller", "observer"].map((roleName) => (
          <div key={roleName}>
            <span>{ROLE_LABELS[roleName]}</span>
            <strong>{roleCounts[roleName] || 0}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function NotificationPanel({ notifications }) {
  return (
    <section className="side-panel">
      <div className="subhead">
        <h3>Live Alerts</h3>
        <span>{notifications.length}</span>
      </div>
      <div className="notifications">
        {notifications.length === 0 ? (
          <div className="empty-panel">No live alerts yet.</div>
        ) : (
          notifications.map((note) => (
            <article className={`notification ${note.level || "info"}`} key={note.id}>
              <strong>{note.title || "Notification"}</strong>
              <p>{note.message}</p>
              <div>
                <span>{formatDateTime(note.timestamp)}</span>
                {note.targetRoles?.length > 0 && (
                  <span>
                    To: {note.targetRoles.map((role) => ROLE_LABELS[role] || role).join(", ")}
                  </span>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function VehicleDirectory({ onSelectVehicle, selectedVin, vehicles }) {
  return (
    <section className="audit-panel">
      <div className="subhead">
        <h3>Vehicle Registry</h3>
        <span>{vehicles.length} vehicles</span>
      </div>
      <div className="vehicle-list">
        {vehicles.map((vehicle) => (
          <button
            key={vehicle.vin}
            className={`vehicle-row ${vehicle.vin === selectedVin ? "active" : ""}`}
            type="button"
            onClick={() => onSelectVehicle(vehicle.vin)}
          >
            <VehicleImage className="directory-thumb" vehicle={vehicle} />
            <span className="vehicle-row-copy">
              <strong>{vehicle.vin}</strong>
              <small>
                {vehicle.vehicle.make} {vehicle.vehicle.model} - {vehicle.owner}
              </small>
            </span>
            <span>{formatKm(vehicle.currentOdometer)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function BlockchainExplorer({ chain, securityEvents }) {
  const latestBlocks = chain.slice().reverse();

  return (
    <section className="audit-panel">
      <div className="subhead">
        <h3>Blockchain Explorer</h3>
        <span>{securityEvents.length} blocked attempts</span>
      </div>
      <div className="block-list">
        {latestBlocks.map((block) => {
          const isSecurity = block.data?.category === "security";
          return (
            <article className={`block-card ${isSecurity ? "security" : ""}`} key={block.hash}>
              <div className="block-topline">
                <strong>Block #{block.index}</strong>
                <span>{block.data?.type || "Unknown"}</span>
              </div>
              <p>
                {block.data?.vin} by {isSecurity ? "Security node" : block.author}
              </p>
              <div className="hash-row">
                <span>Hash: {shortHash(block.hash)}</span>
                <span>Prev: {shortHash(block.previousHash)}</span>
                <span>{formatDateTime(block.timestamp)}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default App;
