import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  downloadTextFile,
  getActorHeaders,
  getFetchCredentials,
  toCsv,
  toNonNegativeInt,
  toPositiveInt,
} from "../utils/common.js";

function formatIsoDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromIsoDateInput(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

function addDays(date, deltaDays) {
  const next = new Date(date);
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function clampDateRange({ start, end }) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()))
    return { start: null, end: null };
  if (!(end instanceof Date) || Number.isNaN(end.getTime()))
    return { start, end: start };
  if (start <= end) return { start, end };
  return { start: end, end: start };
}

function formatAuditDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-PH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function readText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const preferred =
      value.name ??
      value.fullName ??
      value.email ??
      value.label ??
      value.title ??
      value.id ??
      value._id ??
      "";
    return String(preferred || "").trim();
  }
  return String(value).trim();
}

function readPath(source, path) {
  const keys = String(path || "").split(".");
  let current = source;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return null;
}

function normalizeAuditAction(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (lowered.includes("create")) return "created";
  if (lowered.includes("update")) return "updated";
  return "updated";
}

function formatAuditAction(value) {
  return normalizeAuditAction(value) === "created" ? "Created" : "Updated";
}

function formatStockValue(value) {
  return Number.isFinite(value) ? String(value) : "--";
}

function formatStockSummary(row) {
  if (Number.isFinite(row.previousStock) && Number.isFinite(row.nextStock)) {
    if (row.previousStock === row.nextStock) return String(row.nextStock);
    return `${row.previousStock} -> ${row.nextStock}`;
  }
  if (Number.isFinite(row.nextStock)) return String(row.nextStock);
  if (Number.isFinite(row.previousStock)) return String(row.previousStock);
  return "--";
}

function extractAuditLogsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.logs)) return payload.logs;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.logs)) return payload.data.logs;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function parseAuditPagedResponse(payload, fallbacks = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const nested = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};

  const data = extractAuditLogsList(payload);
  const page = toPositiveInt(root.page ?? nested.page, fallbacks.page ?? 1);
  const limit = toPositiveInt(root.limit ?? nested.limit, fallbacks.limit ?? 20);
  const total = toNonNegativeInt(root.total ?? nested.total, fallbacks.total ?? null);
  const hasNext =
    typeof (root.hasNext ?? nested.hasNext) === "boolean"
      ? Boolean(root.hasNext ?? nested.hasNext)
      : typeof (root.has_next ?? nested.has_next) === "boolean"
        ? Boolean(root.has_next ?? nested.has_next)
        : fallbacks.hasNext ?? false;
  const hasPrev =
    typeof (root.hasPrev ?? nested.hasPrev) === "boolean"
      ? Boolean(root.hasPrev ?? nested.hasPrev)
      : typeof (root.has_prev ?? nested.has_prev) === "boolean"
        ? Boolean(root.has_prev ?? nested.has_prev)
        : fallbacks.hasPrev ?? page > 1;

  return { data, page, limit, total, hasNext, hasPrev };
}

function extractItemsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function extractUsersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.users)) return payload.users;
  if (Array.isArray(payload?.data?.users)) return payload.data.users;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function toItemOption(apiItem) {
  if (!apiItem || typeof apiItem !== "object") return null;
  const id =
    apiItem.id ??
    apiItem._id ??
    apiItem.itemId ??
    apiItem.uuid ??
    null;
  if (!id) return null;
  const label =
    String(apiItem.name ?? apiItem.itemName ?? apiItem.item_name ?? id).trim() || String(id);
  return { id: String(id), label };
}

function toUserOption(apiUser) {
  if (!apiUser || typeof apiUser !== "object") return null;
  const id =
    apiUser.id ??
    apiUser._id ??
    apiUser.userId ??
    apiUser.uuid ??
    null;
  if (!id) return null;
  const label =
    String(apiUser.name ?? apiUser.fullName ?? apiUser.email ?? id).trim() || String(id);
  return { id: String(id), label };
}

function uniqOptions(list) {
  const map = new Map();
  for (const option of list || []) {
    if (!option?.id) continue;
    map.set(String(option.id), {
      id: String(option.id),
      label: String(option.label || option.id),
    });
  }
  return Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function normalizeAuditEntry(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = firstValue(raw, ["id", "_id", "auditId", "audit_id", "logId", "log_id"]);
  if (!id) return null;

  const itemId = firstValue(raw, [
    "itemId",
    "item_id",
    "item.id",
    "item._id",
    "entity.id",
    "entity._id",
    "metadata.itemId",
    "metadata.item_id",
  ]);
  const itemName =
    readText(firstValue(raw, ["itemName", "item_name", "item.name", "entity.name", "metadata.itemName"])) ||
    (itemId ? String(itemId) : "");

  const userId = firstValue(raw, [
    "userId",
    "user_id",
    "actorId",
    "actor_id",
    "user.id",
    "user._id",
    "actor.id",
    "actor._id",
    "metadata.userId",
    "metadata.user_id",
  ]);
  const userName =
    readText(
      firstValue(raw, [
        "userName",
        "user_name",
        "actorName",
        "actor_name",
        "user.name",
        "user.fullName",
        "actor.name",
        "actor.fullName",
        "user.email",
        "actor.email",
      ]),
    ) || (userId ? String(userId) : "");

  const action = normalizeAuditAction(
    firstValue(raw, ["stockAction", "stock_action", "action", "event", "type"]),
  );
  const date = firstValue(raw, ["createdAt", "created_at", "timestamp", "date", "loggedAt"]);

  const previousStock = toFiniteNumber(
    firstValue(raw, [
      "beforeStock",
      "before_stock",
      "before.inStock",
      "before.stock",
      "previous.inStock",
      "previous.stock",
      "old.inStock",
      "old.stock",
      "changes.inStock.before",
      "changes.inStock.from",
      "changes.stock.before",
      "changes.stock.from",
      "body.beforeStock",
      "body.before_stock",
    ]),
  );

  const nextStock = toFiniteNumber(
    firstValue(raw, [
      "afterStock",
      "after_stock",
      "after.inStock",
      "after.stock",
      "current.inStock",
      "current.stock",
      "new.inStock",
      "new.stock",
      "changes.inStock.after",
      "changes.inStock.to",
      "changes.stock.after",
      "changes.stock.to",
      "body.afterStock",
      "body.after_stock",
      "body.inStock",
      "body.stock",
    ]),
  );

  const previousTrackStock = toBooleanOrNull(
    firstValue(raw, [
      "beforeTrackStock",
      "before_track_stock",
      "before.trackStock",
      "before.track_stock",
      "previous.trackStock",
      "previous.track_stock",
      "old.trackStock",
      "old.track_stock",
      "changes.trackStock.before",
      "changes.trackStock.from",
      "changes.track_stock.before",
      "changes.track_stock.from",
      "body.beforeTrackStock",
      "body.before_track_stock",
    ]),
  );

  const nextTrackStock = toBooleanOrNull(
    firstValue(raw, [
      "afterTrackStock",
      "after_track_stock",
      "after.trackStock",
      "after.track_stock",
      "current.trackStock",
      "current.track_stock",
      "new.trackStock",
      "new.track_stock",
      "changes.trackStock.after",
      "changes.trackStock.to",
      "changes.track_stock.after",
      "changes.track_stock.to",
      "body.afterTrackStock",
      "body.after_track_stock",
      "body.trackStock",
      "body.track_stock",
    ]),
  );

  return {
    id: String(id),
    itemId: itemId == null ? "" : String(itemId),
    itemName: itemName || "--",
    userId: userId == null ? "" : String(userId),
    userName: userName || "--",
    action,
    actionLabel: formatAuditAction(action),
    date,
    previousStock,
    nextStock,
    previousTrackStock,
    nextTrackStock,
    stockSummary: formatStockSummary({ previousStock, nextStock }),
    raw,
  };
}

export default function StockAuditLogsPage({ apiBaseUrl, authToken, authUser }) {
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [itemId, setItemId] = useState("all");
  const [userId, setUserId] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [auditRows, setAuditRows] = useState([]);
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isFiltersLoading, setIsFiltersLoading] = useState(false);
  const [error, setError] = useState("");

  const lastFetchId = useRef(0);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "GET",
        headers: getAuthHeaders(),
        credentials: getFetchCredentials(),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(message));
      }

      return payload;
    },
    [apiBaseUrl, getAuthHeaders],
  );

  useEffect(() => {
    let cancelled = false;
    setIsFiltersLoading(true);

    (async () => {
      try {
        const itemResults = [];
        const userResults = [];
        const pageSize = 200;

        let currentPage = 1;
        for (let guard = 0; guard < 50; guard += 1) {
          const payload = await apiRequest(
            `/items${buildQueryString({ page: currentPage, limit: pageSize })}`,
          );
          const pageItems = extractItemsList(payload).map(toItemOption).filter(Boolean);
          itemResults.push(...pageItems);
          const paged = parseAuditPagedResponse(payload, { page: currentPage, limit: pageSize });
          if (!paged.hasNext || pageItems.length === 0) break;
          currentPage += 1;
        }

        currentPage = 1;
        for (let guard = 0; guard < 50; guard += 1) {
          const payload = await apiRequest(
            `/users${buildQueryString({ page: currentPage, limit: pageSize })}`,
          );
          const pageUsers = extractUsersList(payload).map(toUserOption).filter(Boolean);
          userResults.push(...pageUsers);
          const paged = parseAuditPagedResponse(payload, { page: currentPage, limit: pageSize });
          if (!paged.hasNext || pageUsers.length === 0) break;
          currentPage += 1;
        }

        if (cancelled) return;
        setItems(uniqOptions(itemResults));
        setUsers(uniqOptions(userResults));
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) setIsFiltersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiRequest]);

  useEffect(() => {
    setPage(1);
  }, [actionFilter, endDate, itemId, limit, startDate, userId]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const collected = [];
        const pageSize = 200;
        let currentPage = 1;

        for (let guard = 0; guard < 50; guard += 1) {
          const payload = await apiRequest(
            `/audit-logs/items/stock${buildQueryString({
              from: formatIsoDateInput(clamped.start),
              to: formatIsoDateInput(clamped.end),
              page: currentPage,
              limit: pageSize,
              ...(itemId !== "all" ? { itemId } : null),
              ...(userId !== "all" ? { userId } : null),
            })}`,
          );

          const parsed = parseAuditPagedResponse(payload, { page: currentPage, limit: pageSize });
          const normalized = parsed.data.map(normalizeAuditEntry).filter(Boolean);
          collected.push(...normalized);

          if (!parsed.hasNext || normalized.length === 0) break;
          currentPage += 1;
        }

        if (fetchId !== lastFetchId.current) return;
        setAuditRows(collected);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load stock audit logs.");
        setAuditRows([]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, endDate, itemId, startDate, userId]);

  const filteredRows = useMemo(() => {
    return actionFilter === "all"
      ? auditRows
      : auditRows.filter((row) => row.action === actionFilter);
  }, [actionFilter, auditRows]);

  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const rows = useMemo(() => {
    const start = (page - 1) * limit;
    return filteredRows.slice(start, start + limit);
  }, [filteredRows, limit, page]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (!selected) return;
    if (rows.some((row) => row.id === selected.id)) return;
    setSelected(null);
  }, [rows, selected]);

  const exportCsv = useCallback(() => {
    const csv = `${toCsv([
      [
        "Item",
        "User",
        "Action",
        "Before Stock",
        "After Stock",
        "Before Track Stock",
        "After Track Stock",
        "Stock",
        "Date",
        "Item ID",
        "User ID",
        "Log ID",
      ],
      ...rows.map((row) => [
        row.itemName,
        row.userName,
        row.actionLabel,
        formatStockValue(row.previousStock),
        formatStockValue(row.nextStock),
        row.previousTrackStock == null ? "--" : row.previousTrackStock ? "Yes" : "No",
        row.nextTrackStock == null ? "--" : row.nextTrackStock ? "Yes" : "No",
        row.stockSummary,
        row.date ? new Date(row.date).toISOString() : "",
        row.itemId,
        row.userId,
        row.id,
      ]),
    ])}\n`;
    const filename = `stock-audit_${startDate || "start"}_${endDate || "end"}_${actionFilter}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [actionFilter, endDate, rows, startDate]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Stock audit">
        <div className="salesSummaryHeaderTitle">Stock audit</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date range">
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Previous period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
                setStartDate(formatIsoDateInput(addDays(clamped.start, -days)));
                setEndDate(formatIsoDateInput(addDays(clamped.end, -days)));
              }}
              disabled={isLoading}
            >
              {"<"}
            </button>
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={startDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setStartDate(todayKey);
                    return;
                  }
                  setStartDate(next);
                }}
                aria-label="Start date"
                max={todayKey}
                disabled={isLoading}
              />
              <span className="salesSummaryRangeDash" aria-hidden="true">
                --
              </span>
              <input
                className="salesSummaryDateInput"
                type="date"
                value={endDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setEndDate(todayKey);
                    return;
                  }
                  setEndDate(next);
                }}
                aria-label="End date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Next period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
                const candidateEnd = addDays(clamped.end, days);
                const candidateEndKey = formatIsoDateInput(candidateEnd);
                if (todayKey && candidateEndKey > todayKey) {
                  const todayDate = dateFromIsoDateInput(todayKey);
                  if (!todayDate) return;
                  setEndDate(todayKey);
                  setStartDate(formatIsoDateInput(addDays(todayDate, -(days - 1))));
                  return;
                }
                setStartDate(formatIsoDateInput(addDays(clamped.start, days)));
                setEndDate(candidateEndKey);
              }}
              disabled={isLoading || (todayKey && endDate && endDate >= todayKey)}
            >
              {">"}
            </button>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              aria-label="Item filter"
              disabled={isLoading || isFiltersLoading}
            >
              <option value="all">All items</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="User filter"
              disabled={isLoading || isFiltersLoading}
            >
              <option value="all">All users</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              aria-label="Action filter"
              disabled={isLoading}
            >
              <option value="all">All actions</option>
              <option value="created">Created</option>
              <option value="updated">Updated</option>
            </select>
          </div>

          <div className="salesSummaryFiltersRight">
            <div className="salesByItemRangeMeta" title={rangeLabel}>
              {rangeLabel}
            </div>
          </div>
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="receiptsReportContent">
        <div className="receiptsReportMain">
          <div className="card salesSummaryTableCard">
            <div className="salesSummaryTableHeader">
              <div className="salesSummaryExportLabel">EXPORT</div>
              <div className="receiptsReportHeaderRight">
                <button
                  className="btn btnGhost btnSmall"
                  type="button"
                  onClick={exportCsv}
                  disabled={isLoading || rows.length === 0}
                >
                  Download CSV
                </button>
              </div>
            </div>

            <div className="tableWrap">
              <table className="table receiptsTable" aria-label="Stock audit table">
                <thead>
                  <tr>
                    <th className="colName">Item</th>
                    <th className="receiptsColEmployee">User</th>
                    <th className="receiptsColType">Action</th>
                    <th className="colStock">Stock</th>
                    <th className="receiptsColDate">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="usersEmpty">
                        {isLoading ? "Loading..." : "No stock audit entries found."}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`receiptsRow ${selected?.id === row.id ? "receiptsRowActive" : ""}`}
                        onClick={() => setSelected(row)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setSelected(row);
                        }}
                      >
                        <td className="colName">{row.itemName || row.itemId || row.id}</td>
                        <td className="receiptsColEmployee">{row.userName || "--"}</td>
                        <td className="receiptsColType">{row.actionLabel}</td>
                        <td className="colStock">{formatStockValue(row.nextStock)}</td>
                        <td className="receiptsColDate">{formatAuditDate(row.date)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="salesSummaryPager" aria-label="Pagination">
              <div className="pagerButtons" aria-label="Page controls">
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Previous page"
                  disabled={!hasPrev || page <= 1 || isLoading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={!hasNext || page >= totalPages || isLoading}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  {">"}
                </button>
              </div>

              <div className="pagerMeta">
                <span>Page:</span>
                <span className="salesSummaryPagerStrong">{page}</span>
                <span>of {totalPages}</span>
              </div>

              <div className="pagerMeta">
                <span>Rows per page:</span>
                <select
                  className="select selectSmall"
                  value={String(limit)}
                  onChange={(e) => setLimit(toPositiveInt(e.target.value, limit))}
                  disabled={isLoading}
                  aria-label="Rows per page"
                >
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <aside className={`receiptsReportDrawer ${selected ? "receiptsReportDrawerOpen" : ""}`}>
          {selected ? (
            <div className="receiptsDrawerBody" role="dialog" aria-label="Stock audit details">
              <div className="receiptsDrawerTop">
                <button
                  className="receiptsDrawerClose"
                  type="button"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  &times;
                </button>
              </div>

              <div className="receiptsDrawerTotal">{selected.stockSummary}</div>
              <div className="receiptsDrawerTotalLabel">Stock value</div>
              <div className="receiptsDrawerDivider" aria-hidden="true" />

              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemName}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemId || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">User</span>
                  <span className="receiptsDrawerMetaValue">{selected.userName || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">User ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.userId || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Action</span>
                  <span className="receiptsDrawerMetaValue">{selected.actionLabel}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Before stock</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatStockValue(selected.previousStock)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">After stock</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatStockValue(selected.nextStock)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Before track stock</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.previousTrackStock == null
                      ? "--"
                      : selected.previousTrackStock
                        ? "Yes"
                        : "No"}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">After track stock</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.nextTrackStock == null
                      ? "--"
                      : selected.nextTrackStock
                        ? "Yes"
                        : "No"}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Date</span>
                  <span className="receiptsDrawerMetaValue">{formatAuditDate(selected.date)}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Log ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.id}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">Select a stock audit entry to view details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
