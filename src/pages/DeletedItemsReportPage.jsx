import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  downloadTextFile,
  getActorHeaders,
  getFetchCredentials,
  toCsv,
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
  const nested =
    root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};

  const data = extractAuditLogsList(payload);
  const page = toPositiveInt(root.page ?? nested.page, fallbacks.page ?? 1);
  const limit = toPositiveInt(root.limit ?? nested.limit, fallbacks.limit ?? 20);
  const hasNext =
    typeof (root.hasNext ?? nested.hasNext) === "boolean"
      ? Boolean(root.hasNext ?? nested.hasNext)
      : typeof (root.has_next ?? nested.has_next) === "boolean"
        ? Boolean(root.has_next ?? nested.has_next)
        : fallbacks.hasNext ?? false;

  return { data, page, limit, hasNext };
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

function normalizeDeletedItemLog(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = firstValue(raw, ["id", "_id", "auditId", "audit_id", "logId", "log_id"]);
  if (!id) return null;

  const itemId = firstValue(raw, [
    "itemId",
    "item_id",
    "resourceId",
    "resource_id",
    "item.id",
    "item._id",
    "entity.id",
    "entity._id",
  ]);

  const itemName =
    readText(
      firstValue(raw, [
        "itemName",
        "item_name",
        "resourceName",
        "resource_name",
        "item.name",
        "entity.name",
      ]),
    ) || (itemId ? String(itemId) : "");

  const userId = firstValue(raw, [
    "userId",
    "user_id",
    "actorId",
    "actor_id",
    "user.id",
    "user._id",
    "actor.id",
    "actor._id",
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

  return {
    id: String(id),
    itemId: itemId == null ? "" : String(itemId),
    itemName: itemName || "--",
    userId: userId == null ? "" : String(userId),
    userName: userName || "--",
    action: "deleted",
    actionLabel: "Deleted",
    date: firstValue(raw, ["createdAt", "created_at", "timestamp", "date", "loggedAt"]),
    raw,
  };
}

export default function DeletedItemsReportPage({ apiBaseUrl, authToken, authUser }) {
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [itemId, setItemId] = useState("all");
  const [userId, setUserId] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [auditRows, setAuditRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
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
    setPage(1);
  }, [endDate, itemId, limit, startDate, userId]);

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
            `/audit-logs/items/deleted${buildQueryString({
              from: formatIsoDateInput(clamped.start),
              to: formatIsoDateInput(clamped.end),
              page: currentPage,
              limit: pageSize,
            })}`,
          );

          const parsed = parseAuditPagedResponse(payload, { page: currentPage, limit: pageSize });
          const normalized = parsed.data.map(normalizeDeletedItemLog).filter(Boolean);
          collected.push(...normalized);

          if (!parsed.hasNext || normalized.length === 0) break;
          currentPage += 1;
        }

        if (fetchId !== lastFetchId.current) return;
        setAuditRows(collected);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load deleted item logs.");
        setAuditRows([]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, endDate, startDate]);

  const itemOptions = useMemo(() => {
    return uniqOptions(
      auditRows.map((row) => ({
        id: row.itemId || row.id,
        label: row.itemName || row.itemId || row.id,
      })),
    );
  }, [auditRows]);

  const userOptions = useMemo(() => {
    return uniqOptions(
      auditRows.map((row) => ({
        id: row.userId || row.id,
        label: row.userName || row.userId || row.id,
      })),
    );
  }, [auditRows]);

  const filteredRows = useMemo(() => {
    return auditRows.filter((row) => {
      if (itemId !== "all" && row.itemId !== itemId) return false;
      if (userId !== "all" && row.userId !== userId) return false;
      return true;
    });
  }, [auditRows, itemId, userId]);

  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const rows = useMemo(() => {
    const offset = (page - 1) * limit;
    return filteredRows.slice(offset, offset + limit);
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
      ["Item", "Deleted by", "Action", "Date", "Item ID", "User ID", "Log ID"],
      ...rows.map((row) => [
        row.itemName,
        row.userName,
        row.actionLabel,
        row.date ? new Date(row.date).toISOString() : "",
        row.itemId,
        row.userId,
        row.id,
      ]),
    ])}\n`;
    const filename = `deleted-items_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [endDate, rows, startDate]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Deleted items">
        <div className="salesSummaryHeaderTitle">Deleted items</div>
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
              aria-label="Deleted item filter"
              disabled={isLoading}
            >
              <option value="all">All deleted items</option>
              {itemOptions.map((item) => (
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
              aria-label="Deleted by filter"
              disabled={isLoading}
            >
              <option value="all">All users</option>
              {userOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
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
              <table className="table receiptsTable" aria-label="Deleted items table">
                <thead>
                  <tr>
                    <th className="colName">Item</th>
                    <th className="receiptsColEmployee">Deleted by</th>
                    <th className="receiptsColType">Action</th>
                    <th className="receiptsColDate">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="usersEmpty">
                        {isLoading ? "Loading..." : "No deleted item logs found."}
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
                  disabled={!hasPrev || isLoading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={!hasNext || isLoading}
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
            <div className="receiptsDrawerBody" role="dialog" aria-label="Deleted item details">
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

              <div className="receiptsDrawerTotal">{selected.itemName || selected.itemId}</div>
              <div className="receiptsDrawerTotalLabel">Deleted item</div>
              <div className="receiptsDrawerDivider" aria-hidden="true" />

              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemName || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemId || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Deleted by</span>
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
            <div className="receiptsDrawerEmpty">Select a deleted item entry to view details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
