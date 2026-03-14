export function makeId(prefix = "id") {
  if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID();
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function safeParseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function safeParseList(raw) {
  const parsed = safeParseJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v) => v && typeof v === "object");
}

export function compareValues(aValue, bValue) {
  const aIsNil = aValue == null;
  const bIsNil = bValue == null;
  if (aIsNil && bIsNil) return 0;
  if (aIsNil) return 1;
  if (bIsNil) return -1;

  if (typeof aValue === "number" && typeof bValue === "number") {
    if (!Number.isFinite(aValue) && !Number.isFinite(bValue)) return 0;
    if (!Number.isFinite(aValue)) return 1;
    if (!Number.isFinite(bValue)) return -1;
    return aValue - bValue;
  }

  const aString = String(aValue);
  const bString = String(bValue);
  return aString.localeCompare(bString, undefined, { sensitivity: "base" });
}

export function readLocalStorage(key, fallback = null) {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocalStorage(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function loadCategoryNamesFromStorage(key = "pos.categories.v1") {
  const raw = readLocalStorage(key, "");
  const list = safeParseList(raw);
  return list
    .map((c) => (c && typeof c === "object" ? String(c.name ?? "").trim() : ""))
    .filter(Boolean);
}

export function loadCategoriesFromStorage(key = "pos.categories.v1") {
  const raw = readLocalStorage(key, "");
  const list = safeParseList(raw);
  return list
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const id = c.id ?? c._id ?? c.categoryId ?? c.uuid ?? null;
      const name = String(c.name ?? "").trim();
      if (!name) return null;
      return { id: id == null ? null : String(id), name };
    })
    .filter(Boolean);
}

export function getActorHeaders(authUser) {
  if (!authUser || typeof authUser !== "object") return {};
  const id = authUser.id ?? authUser._id ?? authUser.userId ?? authUser.uuid ?? "";
  const email = authUser.email ?? "";
  const headers = {};
  if (id) headers["X-Actor-Id"] = String(id);
  if (email) headers["X-Actor-Email"] = String(email);
  return headers;
}

export function resolveStoreId(authUser) {
  if (!authUser || typeof authUser !== "object") return "";
  const raw =
    authUser.storeId ??
    authUser.store_id ??
    authUser.assignedStoreId ??
    authUser.assigned_store_id ??
    authUser.store?.id ??
    authUser.store?._id ??
    authUser.store?.storeId ??
    "";
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}

export function getFetchCredentials() {
  const raw = import.meta?.env?.VITE_FETCH_CREDENTIALS;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "include") return "include";
  if (value === "same-origin") return "same-origin";
  return "omit";
}

export function normalizeUserRole(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const lowered = raw.toLowerCase();
  if (!lowered) return "employee";

  if (lowered === "store_owner" || lowered === "store-owner" || lowered === "store owner")
    return "owner";

  if (lowered === "admin" || lowered === "administrator" || lowered.includes("admin")) return "admin";
  if (lowered === "owner" || lowered.includes("owner")) return "owner";
  if (lowered === "cashier" || lowered.includes("cashier")) return "cashier";
  if (lowered === "employee" || lowered.includes("employee") || lowered.includes("staff"))
    return "employee";

  return "employee";
}

export function getAuthUserRole(authUser) {
  if (!authUser || typeof authUser !== "object") return "employee";
  return normalizeUserRole(authUser.userType ?? authUser.role ?? authUser.type ?? "");
}

export function getReportStoreId(authUser) {
  const role = getAuthUserRole(authUser);
  if (role === "admin") return "";
  return resolveStoreId(authUser);
}

export function getAuthUserSummary(authUser) {
  if (!authUser || typeof authUser !== "object") {
    return { id: "", name: "", email: "", role: "employee", store: "" };
  }

  const id = authUser.id ?? authUser._id ?? authUser.userId ?? authUser.uuid ?? "";
  const email = String(authUser.email ?? "").trim();
  const name = String(
    authUser.name ?? authUser.fullName ?? authUser.username ?? authUser.displayName ?? "",
  ).trim();
  const role = getAuthUserRole(authUser);

  const storeRaw =
    authUser.storeName ??
    authUser.store_name ??
    authUser.store?.name ??
    authUser.store?.storeName ??
    authUser.store?.label ??
    "";
  const storeIdRaw =
    authUser.storeId ??
    authUser.store_id ??
    authUser.assignedStoreId ??
    authUser.assigned_store_id ??
    authUser.store?.id ??
    authUser.store?._id ??
    authUser.store?.storeId ??
    "";

  const storeName = String(storeRaw ?? "").trim();
  const storeId = String(storeIdRaw ?? "").trim();
  const store = storeName || storeId || "";

  return {
    id: id ? String(id) : "",
    name,
    email,
    role,
    store,
  };
}

export function toPositiveInt(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

export function toNonNegativeInt(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 0 ? i : fallback;
}

export function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function parsePagedResponse(payload, fallbacks = {}) {
  const data =
    (Array.isArray(payload?.data) && payload.data) ||
    (Array.isArray(payload?.items) && payload.items) ||
    (Array.isArray(payload?.results) && payload.results) ||
    (Array.isArray(payload) && payload) ||
    fallbacks.data ||
    [];

  const page = toPositiveInt(payload?.page, fallbacks.page ?? 1);
  const limit = toPositiveInt(payload?.limit, fallbacks.limit ?? 20);
  const total = toNonNegativeInt(payload?.total, fallbacks.total ?? null);

  const hasNext =
    typeof payload?.hasNext === "boolean"
      ? payload.hasNext
      : typeof payload?.has_next === "boolean"
        ? payload.has_next
        : fallbacks.hasNext ?? false;

  const hasPrev =
    typeof payload?.hasPrev === "boolean"
      ? payload.hasPrev
      : typeof payload?.has_prev === "boolean"
        ? payload.has_prev
        : fallbacks.hasPrev ?? page > 1;

  return { data, page, limit, total, hasNext, hasPrev };
}

export function toCsv(rows) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  };

  return (Array.isArray(rows) ? rows : []).map((row) => row.map(escape).join(",")).join("\n");
}

export function downloadTextFile({ filename, content, mime = "text/plain;charset=utf-8" }) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function countDelimiterCandidates(line, delimiter) {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) count += 1;
  }

  return count;
}

function detectCsvDelimiter(input) {
  const candidates = [",", ";", "\t"];
  const previewLines = String(input ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (!previewLines.length) return ",";

  let bestDelimiter = ",";
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = previewLines.reduce(
      (sum, line) => sum + countDelimiterCandidates(line, candidate),
      0,
    );
    if (score > bestScore) {
      bestDelimiter = candidate;
      bestScore = score;
    }
  }

  return bestDelimiter;
}

export function parseCsv(text, options = {}) {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  const delimiter =
    typeof options?.delimiter === "string" && options.delimiter
      ? options.delimiter
      : detectCsvDelimiter(input);
  const rows = [];
  let row = [];
  let cell = "";
  let index = 0;
  let inQuotes = false;

  while (index < input.length) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }

      cell += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }

    if (char === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += input[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}
